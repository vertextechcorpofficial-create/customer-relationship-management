import { NextRequest, NextResponse } from "next/server";
import { AllocationError, directusPage, directusWrite, requireWarehouse, resolveAllocationAccess } from "../_lib/access";
import { allocationSnapshot, READINESS_BLOCKERS } from "../_lib/read-model";
import { quantity, quantityText } from "@/modules/customer-relationship-management/customer-hub/sales-order-allocation/domain/quantities";
import { canonicalUnit } from "@/modules/customer-relationship-management/customer-hub/sales-order-allocation/domain/units";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ operation: string[] }> };
async function mapLimited<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await task(items[index]);
        }
    }));
    return results;
}
function json(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } }); }
function failure(error: unknown) {
    return error instanceof AllocationError ? json({ code: error.code, message: error.message }, error.status)
        : json({ code: "ALLOCATION_READ_UNAVAILABLE", message: "Allocation data could not be read. No changes were made." }, 503);
}
type WriteOperation = { collection: string; id: number; payload: Record<string, unknown>; rollback: Record<string, unknown> };
async function applyWithRollback(operations: WriteOperation[]) {
    const attempted: WriteOperation[] = [];
    try {
        for (const operation of operations) {
            // Include the current request in compensation: a network timeout may
            // happen after Directus committed but before its response arrived.
            attempted.push(operation);
            await directusWrite(operation.collection, operation.id, operation.payload);
        }
    } catch (error) {
        const rollbackErrors: string[] = [];
        for (const operation of attempted.reverse()) {
            try { await directusWrite(operation.collection, operation.id, operation.rollback); }
            catch { rollbackErrors.push(`${operation.collection}:${operation.id}`); }
        }
        if (rollbackErrors.length) throw new AllocationError("ROLLBACK_INCOMPLETE", `Allocation write failed and rollback needs review for ${rollbackErrors.join(", ")}. Refresh the order before retrying.`, 500);
        throw new AllocationError("WRITE_ROLLED_BACK", `${error instanceof Error ? error.message : "Write failed"}. Previous quantities were restored.`, 502);
    }
}
function parseIds(value: unknown): number[] {
    if (!Array.isArray(value) || !value.length || value.length > 100) throw new AllocationError("INVALID_REQUEST", "Select between 1 and 100 orders.", 400);
    const ids = value.map(Number);
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) throw new AllocationError("INVALID_REQUEST", "Order IDs must be unique positive integers.", 400);
    return ids;
}
async function allocationWarehouseDraftOrders(orderIds: number[], context: Awaited<ReturnType<typeof resolveAllocationAccess>>) {
    const rows = await directusPage<Record<string, unknown>>("sales_order", {
        order_id: { _in: orderIds }, branch_id: { _eq: context.warehouses[0].id }, order_status: { _eq: "Draft" },
    }, "order_id,branch_id,order_status,allocated_amount,modified_date,for_consolidation_at", 150, 0, "order_id");
    if (rows.length !== orderIds.length) throw new AllocationError("ORDER_NOT_ELIGIBLE", "Every selected order must still be a Draft at Warehouse - DRY22.", 409);
    return rows;
}
function amountForAllocation(netAmount: unknown, orderedQuantity: bigint, allocatedQuantity: bigint): number {
    if (orderedQuantity <= 0n) return 0;
    const net = Number(netAmount);
    if (!Number.isFinite(net) || net < 0) throw new AllocationError("INVALID_ORDER_AMOUNT", "An order amount is invalid; no allocation was saved.", 409);
    const ordered = Number(orderedQuantity) / 1_000_000;
    const allocated = Number(allocatedQuantity) / 1_000_000;
    return Math.round((net / ordered * allocated + Number.EPSILON) * 100) / 100;
}

export async function GET(request: NextRequest, route: RouteContext) {
    try {
        const context = await resolveAllocationAccess();
        const operation = (await route.params).operation;
        if (operation.length === 1 && operation[0] === "context") {
            // Never serialize the session token to the browser.
            return json({ user: context.user, warehouses: context.warehouses, capabilities: context.capabilities, mode: "manual-write-enabled", blockers: READINESS_BLOCKERS });
        }
        if (!(operation.length === 1 && ["overview", "queue", "inventory", "shortages", "history"].includes(operation[0])) && !(operation.length === 2 && operation[0] === "orders" && /^\d+$/.test(operation[1]))) throw new AllocationError("NOT_FOUND", "Unknown allocation operation", 404);
        const requestedWarehouse = request.nextUrl.searchParams.get("warehouseId");
        const page = Number(request.nextUrl.searchParams.get("page") || "1");
        let snapshots;
        if (requestedWarehouse === "all") {
            // Only warehouses that actually have Draft orders can contribute
            // rows to this matrix. Avoid an inventory/read-model fan-out for the
            // other 90+ active warehouses on every page load.
            const scopes = [requireWarehouse(context, context.warehouses[0].id)];
            snapshots = await mapLimited(scopes, 6, warehouse => allocationSnapshot(context, warehouse, page));
        } else {
            snapshots = [await allocationSnapshot(context, requireWarehouse(context, requestedWarehouse), page)];
        }
        const snapshot = requestedWarehouse !== "all" ? snapshots[0] : {
            ...snapshots[0],
            warehouse: context.warehouses[0],
            readAt: new Date().toISOString(),
            orders: snapshots.flatMap(row => row.orders).sort((a, b) => a.id - b.id),
            inventory: snapshots.flatMap(row => row.inventory),
            inventoryError: snapshots.map(row => row.inventoryError).filter(Boolean).join(" ") || null,
            blockers: [...new Set(snapshots.flatMap(row => row.blockers))],
            history: { ...snapshots[0].history, rows: snapshots.flatMap(row => row.history.rows).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 25), hasMore: snapshots.some(row => row.history.hasMore) },
            summary: {
                orders: snapshots.reduce((sum, row) => sum + row.summary.orders, 0),
                fullLegacy: snapshots.reduce((sum, row) => sum + row.summary.fullLegacy, 0),
                partialLegacy: snapshots.reduce((sum, row) => sum + row.summary.partialLegacy, 0),
                unallocated: snapshots.reduce((sum, row) => sum + row.summary.unallocated, 0),
                excludedDrafts: snapshots.reduce((sum, row) => sum + row.summary.excludedDrafts, 0),
                excludedClosed: snapshots.reduce((sum, row) => sum + row.summary.excludedClosed, 0),
                allocatedByUnit: Object.fromEntries(snapshots.flatMap(row => Object.entries(row.summary.allocatedByUnit)).reduce((map, [unit, value]) => map.set(unit, quantityText((map.has(unit) ? quantity(map.get(unit)!) : 0n) + quantity(value))), new Map<string, string>())),
            },
        };
        if (operation[0] === "orders") {
            const order = snapshot.orders.find(row => row.id === Number(operation[1]));
            if (!order) throw new AllocationError("ORDER_DENIED", "Order not found in the authorized warehouse", 404);
            return json({ order, mode: snapshot.mode, blockers: snapshot.blockers });
        }
        if (operation[0] === "overview") return json(snapshot);
        if (operation[0] === "queue") return json({ rows: snapshot.orders, mode: snapshot.mode, blockers: snapshot.blockers });
        if (operation[0] === "history") return json(snapshot.history);
        return json({ rows: snapshot.inventory, error: snapshot.inventoryError, mode: snapshot.mode, blockers: snapshot.blockers });
    } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, route: RouteContext) {
    try {
        const context = await resolveAllocationAccess();
        const operation = (await route.params).operation.join("/");
        if (request.headers.get("origin") !== request.nextUrl.origin) throw new AllocationError("ORIGIN_DENIED", "Allocation writes require a same-origin request.");
        let body: Record<string, unknown>;
        try { body = await request.json(); } catch { throw new AllocationError("INVALID_REQUEST", "Invalid allocation request.", 400); }
        const warehouse = requireWarehouse(context, context.warehouses[0].id);

        if (operation === "allocate") {
            if (!Array.isArray(body.updates) || !body.updates.length || body.updates.length > 500) throw new AllocationError("INVALID_REQUEST", "Provide 1 to 500 line allocations.", 400);
            const updates = body.updates.map((value) => {
                if (!value || typeof value !== "object") throw new AllocationError("INVALID_REQUEST", "Invalid line allocation.", 400);
                const item = value as Record<string, unknown>;
                const orderId = Number(item.orderId), detailId = Number(item.detailId);
                if (!Number.isSafeInteger(orderId) || orderId <= 0 || !Number.isSafeInteger(detailId) || detailId <= 0 || typeof item.quantity !== "string") throw new AllocationError("INVALID_REQUEST", "Each allocation needs an order ID, detail ID and quantity.", 400);
                let target: bigint;
                try { target = quantity(item.quantity); } catch { throw new AllocationError("INVALID_QUANTITY", "Allocation quantities must be non-negative with at most six decimals.", 400); }
                return { orderId, detailId, raw: item.quantity, target };
            });
            if (new Set(updates.map(item => item.detailId)).size !== updates.length) throw new AllocationError("INVALID_REQUEST", "A detail line can only appear once per save.", 400);
            const orderIds = [...new Set(updates.map(item => item.orderId))];
            const headers = await allocationWarehouseDraftOrders(orderIds, context);
            const orderHeaderMap = new Map(headers.map(row => [Number(row.order_id), row]));
            const details = await directusPage<Record<string, unknown>>("sales_order_details", { order_id: { _in: orderIds } }, "detail_id,order_id,product_id,ordered_quantity,allocated_quantity,served_quantity,unit_price,net_amount,allocated_amount", 5000, 0, "detail_id");
            const detailsById = new Map(details.map(row => [Number(row.detail_id), row]));
            if (updates.some(update => Number(detailsById.get(update.detailId)?.order_id) !== update.orderId)) throw new AllocationError("DETAIL_NOT_ELIGIBLE", "A selected line does not belong to its Draft order.", 409);

            // Recheck the latest inventory and all Draft allocations before writing.
            const snapshot = await allocationSnapshot(context, warehouse, 1);
            if (snapshot.inventoryError) throw new AllocationError("STOCK_UNVERIFIED", "Warehouse - DRY22 inventory could not be verified. No allocation was saved.", 503);
            const snapshotLines = new Map(snapshot.orders.flatMap(order => order.lines.map(line => [line.id, { order, line }] as const)));
            const targetChangesByStockKey = new Map<string, bigint>();
            for (const update of updates) {
                const lineInfo = snapshotLines.get(update.detailId);
                const detail = detailsById.get(update.detailId)!;
                if (!lineInfo || lineInfo.order.id !== update.orderId) throw new AllocationError("STALE_ORDER", "Order data changed while you were editing. Refresh and retry.", 409);
                let ordered: bigint, served: bigint, previous: bigint;
                try {
                    ordered = quantity(lineInfo.line.ordered);
                    served = quantity(String(detail.served_quantity ?? "0"));
                    previous = quantity(lineInfo.line.legacyAllocated);
                } catch { throw new AllocationError("INVALID_ORDER_QUANTITY", "An order quantity needs reconciliation. No allocation was saved.", 409); }
                if (previous !== quantity(String(detail.allocated_quantity ?? "0"))) throw new AllocationError("STALE_ORDER", "Allocation changed in another session. Refresh before retrying.", 409);
                if (update.target > ordered || update.target < served) throw new AllocationError("QUANTITY_OUT_OF_RANGE", `${lineInfo.line.product}: allocation must be between already served and ordered quantity.`, 409);
                const stockKey = `${lineInfo.line.productId}:${lineInfo.order.supplierId ?? "unknown"}:${canonicalUnit(lineInfo.line.unit)}`;
                targetChangesByStockKey.set(stockKey, (targetChangesByStockKey.get(stockKey) || 0n) + update.target - previous);
            }
            for (const [stockKey, delta] of targetChangesByStockKey) {
                const [productId, supplierId, unit] = stockKey.split(":");
                let existing = 0n;
                for (const order of snapshot.orders) if (String(order.supplierId ?? "unknown") === supplierId) for (const line of order.lines) {
                    if (String(line.productId) === productId && canonicalUnit(line.unit) === unit) existing += quantity(line.legacyAllocated);
                }
                const inventory = snapshot.inventory.filter(row => String(row.productId) === productId && String(row.supplierId ?? "unknown") === supplierId && canonicalUnit(row.unit) === unit);
                if (inventory.length !== 1 || inventory[0].ambiguous || inventory[0].reportedStock === null) throw new AllocationError("STOCK_UNVERIFIED", `Inventory for product ${productId} is unknown or ambiguous. No allocation was saved.`, 409);
                if (existing + delta > quantity(inventory[0].reportedStock)) throw new AllocationError("INSUFFICIENT_STOCK", `Warehouse - DRY22 reported stock is insufficient for product ${productId}. No allocation was saved.`, 409);
            }

            const lineValues = new Map<number, { quantity: bigint; amount: number }>();
            for (const update of updates) {
                const detail = detailsById.get(update.detailId)!;
                const ordered = quantity(String(detail.ordered_quantity));
                const amount = amountForAllocation(detail.net_amount, ordered, update.target);
                lineValues.set(update.detailId, { quantity: update.target, amount });
            }
            const writeOperations: WriteOperation[] = [];
            for (const update of updates) {
                const detail = detailsById.get(update.detailId)!;
                const next = lineValues.get(update.detailId)!;
                writeOperations.push({ collection: "sales_order_details", id: update.detailId,
                    payload: { allocated_quantity: quantityText(next.quantity), allocated_amount: next.amount },
                    rollback: { allocated_quantity: detail.allocated_quantity ?? 0, allocated_amount: detail.allocated_amount ?? 0 } });
            }
            for (const orderId of orderIds) {
                const header = orderHeaderMap.get(orderId)!;
                let allocatedAmount = 0;
                for (const detail of details.filter(row => Number(row.order_id) === orderId)) {
                    allocatedAmount += lineValues.get(Number(detail.detail_id))?.amount ?? Number(detail.allocated_amount ?? 0);
                }
                writeOperations.push({ collection: "sales_order", id: orderId,
                    payload: { allocated_amount: Math.round((allocatedAmount + Number.EPSILON) * 100) / 100, modified_date: new Date().toISOString() },
                    rollback: { allocated_amount: header.allocated_amount ?? 0, modified_date: header.modified_date ?? null } });
            }
            await applyWithRollback(writeOperations);
            return json({ success: true, message: "Allocations saved.", updatedLines: updates.length });
        }

        if (operation === "approve") {
            const orderIds = parseIds(body.orderIds);
            const headers = await allocationWarehouseDraftOrders(orderIds, context);
            const details = await directusPage<Record<string, unknown>>("sales_order_details", { order_id: { _in: orderIds } }, "detail_id,order_id,ordered_quantity,allocated_quantity", 5000, 0, "detail_id");
            for (const orderId of orderIds) {
                const lines = details.filter(row => Number(row.order_id) === orderId);
                if (!lines.length || !lines.some(line => quantity(String(line.ordered_quantity ?? "0")) > 0n && quantity(String(line.allocated_quantity ?? "0")) >= quantity(String(line.ordered_quantity)))) throw new AllocationError("ALLOCATION_INCOMPLETE", `Order ${orderId} must have at least one line fully allocated before approval.`, 409);
            }
            const now = new Date().toISOString();
            const operations: WriteOperation[] = headers.map(header => ({ collection: "sales_order", id: Number(header.order_id),
                payload: { order_status: "For Consolidation", for_consolidation_at: now, modified_date: now },
                rollback: { order_status: header.order_status, for_consolidation_at: header.for_consolidation_at ?? null, modified_date: header.modified_date ?? null } }));
            await applyWithRollback(operations);
            return json({ success: true, message: `${orderIds.length} order(s) moved to For Consolidation.` });
        }
        if (/^\d+\/release$/.test(operation)) throw new AllocationError("RELEASE_DENIED", "Reservation release requires a separate permission and lifecycle integration");
        throw new AllocationError("NOT_FOUND", "Unknown allocation operation", 404);
    } catch (error) { return failure(error); }
}
