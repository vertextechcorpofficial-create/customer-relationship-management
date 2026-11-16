"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCheck, CircleDollarSign, Layers3, Minus, PackageCheck, Plus, RefreshCw, Search, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAllocationWorkspace } from "../hooks/useAllocationWorkspace";
import { quantity, quantityText } from "../domain/quantities";
import { groupCustomerColumns, paginateOrderColumns, sortAllocationOrders, type OrderSort } from "../domain/orderPagination";
import { canonicalUnit } from "../domain/units";
import type { AllocationSnapshot, AllocationOrder, ReportedInventory } from "../types";
import { allocationProvider } from "../providers/allocationProvider";
import { toast } from "sonner";

export default function AllocationMatrix() {
    const workspace = useAllocationWorkspace();
    return <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-2xl font-bold tracking-tight">Sales Order Allocation</h1><p className="mt-1 text-sm text-muted-foreground">Allocate inventory to customer sales orders and approve allocations for consolidation.</p></div><div className="flex items-center gap-2"><Badge variant="secondary" className="px-3 py-1.5">{workspace.context?.warehouses[0]?.name || "Central Warehouse"}</Badge><Button variant="outline" disabled={workspace.loading} onClick={() => { if (!workspace.snapshot || window.confirm("Refresh orders and discard unsaved edits?")) workspace.refresh(); }}><RefreshCw className={`mr-2 h-4 w-4 ${workspace.loading ? "animate-spin" : ""}`} />Refresh</Button></div></div>
        {workspace.error && <p role="alert" className="text-sm text-destructive">{workspace.error}</p>}
        {workspace.loading && <p role="status" className="text-sm text-muted-foreground">Loading orders and inventory…</p>}
        {workspace.snapshot && <Matrix key={`${workspace.warehouseId}:${workspace.snapshot.readAt}`} snapshot={workspace.snapshot} warehouses={workspace.context?.warehouses || []} onRefresh={workspace.refresh} />}
    </div>;
}

interface ProductRow { key: string; warehouseId: number; productId: number; supplierId: number | null; product: string; sku: string; unit: string; supplier: string }
interface MatrixColumn { order: AllocationOrder; customer: string }

export function Matrix({ snapshot, warehouses, onRefresh }: { snapshot: AllocationSnapshot; warehouses: { id: number; name: string }[]; onRefresh: () => void }) {
    const [search, setSearch] = useState("");
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const [destinationFilter, setDestinationFilter] = useState("all");
    const [sortBy, setSortBy] = useState<OrderSort>("latest");
    const initialAllocationValues = useMemo(() => Object.fromEntries(snapshot.orders.flatMap(order => order.lines
        .filter(line => /^\d+(?:\.\d{1,6})?$/.test(line.legacyAllocated))
        .map(line => [line.id, line.legacyAllocated]))) as Record<number, string>, [snapshot.orders]);
    const [values, setValues] = useState<Record<number, string>>(() => initialAllocationValues);
    const [savedValues, setSavedValues] = useState<Record<number, string>>(() => initialAllocationValues);
    const [selectedApprovalIds, setSelectedApprovalIds] = useState<number[]>([]);
    const [approvalPreviewIds, setApprovalPreviewIds] = useState<number[]>([]);
    const [saving, setSaving] = useState(false);
    const [operationError, setOperationError] = useState("");
    const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({});
    const [pageSize, setPageSize] = useState(10);
    const [pageIndex, setPageIndex] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [matrixWidth, setMatrixWidth] = useState(0);
    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        const observer = new ResizeObserver(() => setMatrixWidth(element.clientWidth));
        observer.observe(element);
        setMatrixWidth(element.clientWidth);
        return () => observer.disconnect();
    }, []);
    const warehouseName = (id: number) => id === 0 ? "Warehouse not assigned" : warehouses.find(row => row.id === id)?.name || `Warehouse ${id}`;

    const warehouseNames = useMemo(() => new Map(warehouses.map(warehouse => [warehouse.id, warehouse.name])), [warehouses]);
    const destinationOptions = useMemo(() => [...new Set(snapshot.orders.map(order => order.destination).filter(value => value && value !== "Not specified"))].sort((a, b) => a.localeCompare(b)), [snapshot.orders]);
    const orders = useMemo(() => sortAllocationOrders(snapshot.orders.filter(order => (!start || order.orderDate.slice(0, 10) >= start) && (!end || order.orderDate.slice(0, 10) <= end)
        && (destinationFilter === "all" || order.destination === destinationFilter)
        && (!search || [order.customer, order.customerCode, order.number, order.salesman, order.destination, ...order.lines.flatMap(line => [line.product, line.sku])].join(" ").toLowerCase().includes(search.toLowerCase())))
        , sortBy, warehouseNames), [snapshot.orders, start, end, search, destinationFilter, sortBy, warehouseNames]);

    const orderPage = paginateOrderColumns(orders, pageIndex, pageSize);
    const { pageCount, pageIndex: safePageIndex, startIndex: firstOrderIndex, items: visibleOrders } = orderPage;
    // Customer grouping is visual only. Individual orders remain distinct columns.
    const columns: MatrixColumn[] = visibleOrders.map(order => ({ order, customer: `${order.customer} (${order.customerCode})` }));
    const productColumnWidth = 280;
    const orderColumnWidth = 280;
    const fixedColumnsWidth = productColumnWidth + 70 + 120;
    const summaryColumnWidth = Math.max(90, (matrixWidth - fixedColumnsWidth - columns.length * orderColumnWidth) / 3);
    const customerGroups = groupCustomerColumns(visibleOrders, firstOrderIndex, orders[firstOrderIndex - 1]);

    const rowMap = new Map<string, ProductRow>();
    for (const order of snapshot.orders) for (const line of order.lines) {
        const key = `${order.warehouseId}:${line.productId}:${order.supplierId ?? "unknown"}:${line.unit}`;
        if (!rowMap.has(key)) rowMap.set(key, { key, warehouseId: order.warehouseId, productId: line.productId, supplierId: order.supplierId, product: line.product, sku: line.sku, unit: line.unit, supplier: order.supplier });
    }
    const stockWarehouseId = (stock: ReportedInventory) => {
        const parts = stock.key.split(":");
        return Number(parts[0] === "demand" ? parts[1] : parts[0]);
    };
    const inventoryByRowKey = new Map<string, ReportedInventory[]>();
    for (const stock of snapshot.inventory) {
        const stockWarehouse = stockWarehouseId(stock);
        if (!Number.isSafeInteger(stockWarehouse)) continue;
        const key = `${stockWarehouse}:${stock.productId}:${stock.supplierId ?? "unknown"}:${canonicalUnit(stock.unit)}`;
        const matches = inventoryByRowKey.get(key);
        if (matches) matches.push(stock);
        else inventoryByRowKey.set(key, [stock]);
    }
    // The matrix contains demanded products only. Inventory-only products do not
    // add allocation choices, and must not create a huge product×order grid.
    const allRows = [...rowMap.values()].sort((a, b) => warehouseName(a.warehouseId).localeCompare(warehouseName(b.warehouseId)) || a.product.localeCompare(b.product) || a.unit.localeCompare(b.unit));
    const rows = allRows.filter(row => (!search || `${row.product} ${row.sku} ${row.supplier}`.toLowerCase().includes(search.toLowerCase())));

    let invalid = false;
    const competingByRow = new Map<string, { order: AllocationOrder; line: AllocationOrder["lines"][number] }[]>();
    for (const order of snapshot.orders) for (const line of order.lines) {
        const key = `${order.warehouseId}:${line.productId}:${order.supplierId ?? "unknown"}:${line.unit}`;
        competingByRow.set(key, [...(competingByRow.get(key) || []), { order, line }]);
    }
    const metricsByRow = new Map<string, { stock: bigint | null; planned: bigint; remaining: bigint | null; usedLines: number }>();
    for (const row of allRows) {
        const stockMatches = inventoryByRowKey.get(row.key) || [];
        const stock: bigint | null = stockMatches.length === 1 && !stockMatches[0].ambiguous && stockMatches[0].reportedStock !== null ? quantity(stockMatches[0].reportedStock) : null;
        const competing = competingByRow.get(row.key) || [];
        let planned = 0n;
        let usedLines = 0;
        for (const { line } of competing) {
            const raw = values[line.id] || "";
            if (!raw) continue;
            try {
                const assigned = quantity(raw);
                if (!/^\d+(?:\.\d{1,6})?$/.test(raw) || assigned > quantity(line.ordered) || assigned < quantity(line.served)) invalid = true;
                planned += assigned;
                if (assigned > 0n) usedLines++;
            } catch { invalid = true; }
        }
        if (stock === null && planned > 0n || stock !== null && planned > stock) invalid = true;
        metricsByRow.set(row.key, { stock, planned, remaining: stock === null ? null : stock - planned, usedLines });
    }
    const rowVirtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 68, overscan: 8 });
    const virtualRows = rowVirtualizer.getVirtualItems();
    const renderRow = (row: ProductRow, virtualIndex: number) => {
        const { stock, planned, remaining, usedLines } = metricsByRow.get(row.key) || { stock: null, planned: 0n, remaining: null, usedLines: 0 };
        const otherOwner = stock === null ? snapshot.inventory.filter(item => stockWarehouseId(item) === row.warehouseId && item.productId === row.productId && canonicalUnit(item.unit) === canonicalUnit(row.unit) && !item.ambiguous && item.reportedStock !== null) : [];
        const ownerMismatch = otherOwner.length === 1 && otherOwner[0].supplierId !== row.supplierId ? otherOwner[0] : null;
        return <tr key={row.key} data-index={virtualIndex} ref={rowVirtualizer.measureElement} className="border-b">
            <th scope="row" className="sticky left-0 z-10 w-[280px] min-w-[280px] max-w-[280px] border-r bg-background p-2 text-left font-medium"><span>{row.product}</span><span className="block text-xs font-normal text-muted-foreground">{row.sku} · {row.supplier}</span></th>
            <td className="sticky left-[280px] z-10 w-[70px] min-w-[70px] border-r border-border bg-background p-2 text-sm">{row.unit}</td>
            <td className="sticky left-[350px] z-10 w-[120px] min-w-[120px] border-l border-border bg-background p-2 text-right font-medium">{stock !== null ? <span title="Reported running inventory; reservations are not reconciled.">{quantityText(stock)}<span className="block text-[9px] font-normal text-muted-foreground">Reported stock</span></span> : ownerMismatch ? <span title={`Reported under supplier ${ownerMismatch.supplier}; not verified for this order's supplier`} className="text-amber-700">Mismatch<span className="block text-[9px]">Supplier stock</span></span> : <span className="text-amber-700">Unverified</span>}</td>
            {columns.map(({ order }) => {
                const lines = order.warehouseId === row.warehouseId && order.supplierId === row.supplierId ? order.lines.filter(line => line.productId === row.productId && line.unit === row.unit) : [];
                return <td key={order.id} className="w-[280px] min-w-[280px] max-w-[280px] border-l p-1 align-middle">{lines.length ? lines.map(line => {
                    const inputLocked = stock === null || line.quantityIssue === true;
                    const currentAllocation = values[line.id] || "0";
                    const amountValue = Number(line.ordered) > 0 ? Number(line.orderedNet) / Number(line.ordered) * Number(currentAllocation) : NaN;
                    const allocationAmount = Number.isFinite(amountValue) ? Math.round((amountValue + Number.EPSILON) * 100) / 100 : null;
                    const minimum = /^\d+(?:\.\d{1,6})?$/.test(line.served) ? line.served : "0";
                    const updateQuantity = (next: string) => {
                        let message = "";
                        try {
                            if (!/^\d+(?:\.\d{1,6})?$/.test(next)) message = "Enter a non-negative quantity with up to 6 decimal places.";
                            else if (quantity(next) < quantity(minimum)) message = `Quantity cannot be below served quantity (${minimum}).`;
                            else if (quantity(next) > quantity(line.ordered)) message = `Quantity cannot exceed ordered quantity (${line.ordered}).`;
                            else if (stock !== null) {
                                const rowTotal = (competingByRow.get(row.key) || []).reduce((sum, entry) => {
                                    const raw = entry.line.id === line.id ? next : values[entry.line.id] || "0";
                                    try { return sum + quantity(raw); } catch { return sum; }
                                }, 0n);
                                if (rowTotal > stock) message = `Reported stock is ${quantityText(stock)} ${row.unit}; reduce this or another allocation.`;
                            }
                        } catch { message = "Enter a valid quantity."; }
                        setValues(previous => ({ ...previous, [line.id]: next }));
                        setFieldErrors(previous => ({ ...previous, [line.id]: message }));
                        setOperationError("");
                    };
                    const stepQuantity = (delta: number) => {
                        const current = Number(values[line.id] || "0");
                        const next = Math.min(Number(line.ordered), Math.max(Number(minimum), Math.round((current + delta) * 1_000_000) / 1_000_000));
                        updateQuantity(String(next));
                    };
                    const dirty = (values[line.id] ?? "0") !== (savedValues[line.id] ?? "0");
                    const status = fieldErrors[line.id] ? "Invalid" : saving && dirty ? "Saving…" : dirty ? "Unsaved" : "";
                    return <div key={line.id} className={`space-y-0.5 rounded-md border p-1.5 ${fieldErrors[line.id] ? "border-destructive/50 bg-destructive/5" : dirty ? "border-blue-300 bg-blue-50/60" : "border-border bg-background"}`}>
                        <div className="flex items-center justify-between gap-2 text-[10px] leading-4"><span>Requested <strong>{line.ordered} {line.unit}</strong></span><span className="text-muted-foreground">Saved {savedValues[line.id] ?? "0"}</span></div>
                        <div className="flex items-center gap-1">
                            <Button type="button" size="icon" variant="outline" className="h-6 w-6 shrink-0" aria-label={`Decrease allocation for ${row.product}, ${order.number}`} disabled={inputLocked || saving || Number(currentAllocation) <= Number(minimum)} onClick={() => stepQuantity(-1)}><Minus className="h-3 w-3" /></Button>
                            <Input id={`allocation-${line.id}`} aria-label={`Allocation for ${row.product}, ${order.number}`} aria-invalid={!!fieldErrors[line.id]} className="h-6 w-[96px] min-w-[96px] px-1 text-center tabular-nums" type="number" min={minimum} step="any" max={line.ordered} disabled={inputLocked || saving} value={values[line.id] ?? ""} onChange={event => updateQuantity(event.target.value)} />
                            <Button type="button" size="icon" variant="outline" className="h-6 w-6 shrink-0" aria-label={`Increase allocation for ${row.product}, ${order.number}`} disabled={inputLocked || saving || Number(currentAllocation) >= Number(line.ordered)} onClick={() => stepQuantity(1)}><Plus className="h-3 w-3" /></Button>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-x-2 text-[10px] leading-4"><span className="text-muted-foreground">Remaining {Number.isFinite(Number(currentAllocation)) ? Math.max(0, Number(line.ordered) - Number(currentAllocation)) : "Unverified"}</span><span className="font-semibold">{allocationAmount === null ? "Unverified" : `₱${allocationAmount.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</span></div>
                        {fieldErrors[line.id] && <p role="alert" className="text-[10px] leading-3 text-destructive">{fieldErrors[line.id]}</p>}
                        {status && <span role="status" className="inline-flex rounded bg-muted px-1.5 py-0.5 text-[9px] leading-3 text-muted-foreground">{status}</span>}
                    </div>;
                }) : <span className="px-2 text-muted-foreground">—</span>}</td>;
            })}
            <td style={{ width: summaryColumnWidth }} className="whitespace-nowrap border-l p-2 text-right font-semibold">{quantityText(planned)}</td>
            <td style={{ width: summaryColumnWidth }} className={`whitespace-nowrap border-l p-2 text-right ${remaining !== null && remaining < 0n ? "font-semibold text-destructive" : ""}`}>{remaining === null ? "Unknown" : remaining < 0n ? "Over plan" : quantityText(remaining)}</td>
            <td style={{ width: summaryColumnWidth }} className="border-l p-2 text-xs"><Badge variant="outline" className={stock === null ? "border-amber-200 bg-amber-50 text-amber-800" : stock === 0n || remaining !== null && remaining < 0n ? "border-red-200 bg-red-50 text-red-700" : "border-blue-200 bg-blue-50 text-blue-800"}>{ownerMismatch ? "Supplier mismatch" : stock === null ? "Inventory unverified" : stock === 0n || remaining !== null && remaining < 0n ? "Insufficient stock" : "Reported stock only"}</Badge><p className="mt-1 text-[10px] text-muted-foreground">{ownerMismatch ? "Stock belongs to another supplier." : stock === null ? "Refresh stock before allocating." : usedLines ? `${usedLines} positive allocation(s); not reserved.` : "No positive allocations."}</p></td>
        </tr>;
    };
    const topSpacer = virtualRows.length ? virtualRows[0].start : 0;
    const bottomSpacer = virtualRows.length ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end : 0;
    const lineById = new Map(snapshot.orders.flatMap(order => order.lines.map(line => [line.id, { order, line }] as const)));
    const dirtyUpdates = Object.entries(values).flatMap(([idText, value]) => {
        const detailId = Number(idText), baseline = savedValues[detailId] ?? "0";
        if (value === baseline) return [];
        const owner = lineById.get(detailId);
        return owner ? [{ orderId: owner.order.id, detailId, quantity: value || "0" }] : [];
    });
    async function savePlan() {
        if (!dirtyUpdates.length || invalid) return;
        setSaving(true); setOperationError("");
        try {
            await allocationProvider.saveAllocations(dirtyUpdates);
            setSavedValues({ ...values });
            onRefresh();
        } catch (error) {
            setValues({ ...savedValues });
            setOperationError(error instanceof Error ? error.message : "Allocation failed. Local edits were reverted to the last saved quantities.");
        } finally { setSaving(false); }
    }
    function requestApproval(orderIds: number[]) {
        const chosen = snapshot.orders.filter(order => orderIds.includes(order.id));
        if (!orderIds.length || chosen.length !== orderIds.length || dirtyUpdates.length || chosen.some(order => !isOrderApprovalEligible(order))) return;
        setApprovalPreviewIds(orderIds);
    }
    async function confirmApproval() {
        const orderIds = approvalPreviewIds;
        if (!orderIds.length || dirtyUpdates.length || approvalPreviewOrders.some(order => !isOrderApprovalEligible(order))) return;
        setSaving(true); setOperationError("");
        try {
            await allocationProvider.approveAllocations(orderIds);
            const completedOrders = approvalPreviewOrders.filter(order => orderIds.includes(order.id));
            setApprovalPreviewIds([]);
            toast.success(completedOrders.length === 1 ? "Sales order allocation complete" : "Sales order allocations complete", {
                description: `${completedOrders.map(order => order.number).join(", ")} ${completedOrders.length === 1 ? "is" : "are"} now For Consolidation.`,
            });
            onRefresh();
        } catch (error) {
            setOperationError(error instanceof Error ? error.message : "Approval failed; no status change was confirmed.");
        } finally { setSaving(false); }
    }
    function isOrderFullyAllocated(order: AllocationOrder) {
        return order.lines.length > 0 && order.lines.every(line => {
            try { return quantity(values[line.id] || "0") >= quantity(line.ordered); }
            catch { return false; }
        });
    }
    function isOrderApprovalEligible(order: AllocationOrder) {
        if (!isOrderFullyAllocated(order)) return false;
        return order.lines.every(line => {
            const key = `${order.warehouseId}:${line.productId}:${order.supplierId ?? "unknown"}:${line.unit}`;
            const metric = metricsByRow.get(key);
            return !!metric && metric.stock !== null && metric.planned <= metric.stock;
        });
    }

    const issueRows = allRows.filter(row => { const metric = metricsByRow.get(row.key); return !metric?.stock || metric.stock < metric.planned; }).length;
    const eligibleSelected = snapshot.orders.filter(order => selectedApprovalIds.includes(order.id) && isOrderApprovalEligible(order)).length;
    const allocationValue = (line: AllocationOrder["lines"][number], raw: string) => {
        const ordered = Number(line.ordered), net = Number(line.orderedNet), qty = Number(raw || "0");
        return ordered > 0 && Number.isFinite(net) && Number.isFinite(qty) ? net / ordered * qty : null;
    };
    const totalAmount = snapshot.orders.reduce((sum, order) => sum + order.lines.reduce((lineSum, line) => lineSum + (allocationValue(line, values[line.id] ?? line.legacyAllocated) ?? 0), 0), 0);
    const approvalPreviewOrders = snapshot.orders.filter(order => approvalPreviewIds.includes(order.id));
    const kpis = [
        { label: "Total orders", value: String(snapshot.orders.length), icon: ShoppingCart, tone: "text-blue-700 bg-blue-50" },
        { label: "Verified available stock", value: "Unverified", icon: PackageCheck, tone: "text-amber-700 bg-amber-50" },
        { label: "Lines with issues", value: String(issueRows), icon: AlertTriangle, tone: "text-amber-700 bg-amber-50" },
        { label: "Unsaved changes", value: `${dirtyUpdates.length} lines`, icon: CircleDollarSign, tone: "text-violet-700 bg-violet-50" },
        { label: "Selected orders", value: `${selectedApprovalIds.length} / ${snapshot.orders.length}`, icon: Layers3, tone: "text-slate-700 bg-slate-100" },
    ];

    return <div className="min-w-0 space-y-4">
        <section aria-label="Allocation summary" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">{kpis.map(item => <div key={item.label} className="flex min-h-16 items-center gap-3 rounded-lg border bg-card px-3 py-2"><span className={`rounded-md p-2 ${item.tone}`}><item.icon className="h-4 w-4" /></span><div className="min-w-0"><p className="truncate text-[11px] text-muted-foreground">{item.label}</p><p className="text-lg font-semibold leading-tight">{item.value}</p></div></div>)}</section>
        <div className="flex flex-wrap gap-3 rounded-xl border p-3">
            <div className="min-w-56 flex-1 space-y-1"><label htmlFor="matrix-search" className="text-xs font-medium">Search products, customers or orders</label><div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input id="matrix-search" className="h-9 pl-9" value={search} onChange={event => { setPageIndex(0); setSearch(event.target.value); }} placeholder="Search…" /></div></div>
            <div className="w-44 space-y-1"><label htmlFor="matrix-sort" className="text-xs font-medium">Sort orders</label><Select value={sortBy} onValueChange={value => { setSortBy(value as OrderSort); setPageIndex(0); }}><SelectTrigger id="matrix-sort" className="h-9"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="latest">Latest to earliest</SelectItem><SelectItem value="earliest">Earliest to latest</SelectItem><SelectItem value="destination">Destination</SelectItem><SelectItem value="customer">Customer</SelectItem></SelectContent></Select></div>
            <div className="w-44 space-y-1"><label htmlFor="matrix-destination" className="text-xs font-medium">Destination</label><Select value={destinationFilter} onValueChange={value => { setDestinationFilter(value); setPageIndex(0); }}><SelectTrigger id="matrix-destination" className="h-9"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All destinations</SelectItem>{destinationOptions.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1"><label htmlFor="matrix-from" className="text-xs font-medium">Order date from</label><Input id="matrix-from" className="h-9" type="date" value={start} onChange={event => { setPageIndex(0); setStart(event.target.value); }} /></div><div className="space-y-1"><label htmlFor="matrix-to" className="text-xs font-medium">To</label><Input id="matrix-to" className="h-9" type="date" value={end} onChange={event => { setPageIndex(0); setEnd(event.target.value); }} /></div>
            <div className="w-32 space-y-1"><label htmlFor="matrix-page-size" className="text-xs font-medium">Orders per page</label><Select value={String(pageSize)} onValueChange={value => { setPageSize(Number(value)); setPageIndex(0); }}><SelectTrigger id="matrix-page-size" className="h-9"><SelectValue /></SelectTrigger><SelectContent>{[5, 10, 15].map(size => <SelectItem key={size} value={String(size)}>{size} orders</SelectItem>)}</SelectContent></Select></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><p>{orders.length} matching orders · showing {orders.length ? firstOrderIndex + 1 : 0}–{Math.min(firstOrderIndex + pageSize, orders.length)} · {rows.length} product / UOM rows.</p><Badge variant="outline">Reported running stock · not reserved</Badge></div>
        
        {snapshot.inventoryError && <p role="alert" className="text-sm text-destructive">Some warehouse inventory could not be verified. Quantities for affected rows are disabled.</p>}
        <OrderPagination pageIndex={safePageIndex} pageCount={pageCount} pageSize={pageSize} total={orders.length} onPage={setPageIndex} />
        <div ref={scrollRef} className="max-h-[68vh] w-full overflow-auto rounded-xl border"><table style={{ width: `max(100%, ${430 + columns.length * 220 + summaryColumnWidth * 3}px)` }} className="min-w-max table-fixed border-separate border-spacing-0 text-xs"><thead className="sticky top-0 z-20 bg-muted"><tr className="bg-muted"><th rowSpan={2} className="sticky left-0 z-40 w-[280px] min-w-[280px] max-w-[280px] border-b border-r bg-muted p-2 text-left">Product / SKU</th><th rowSpan={2} className="sticky left-[280px] z-40 w-[70px] min-w-[70px] max-w-[70px] border-b bg-muted p-2 text-left">UOM</th><th rowSpan={2} className="sticky left-[350px] z-40 w-[120px] min-w-[120px] max-w-[120px] border-b bg-muted p-2 text-right">Reported Stock</th>{customerGroups.map((group, index) => <th key={`${group.customer}-${index}`} colSpan={group.count} style={{ width: `${orderColumnWidth * group.count}px` }} className="min-w-[220px] border-b border-l bg-blue-50 p-2 text-center text-blue-950">{group.customer}{group.continued ? " (continued)" : ""}</th>)}<th rowSpan={2} style={{ width: summaryColumnWidth }} className="border-b border-l bg-muted p-2 text-right">Allocated · all orders</th><th rowSpan={2} style={{ width: summaryColumnWidth }} className="border-b border-l bg-muted p-2 text-right">Left in plan</th><th rowSpan={2} style={{ width: summaryColumnWidth }} className="border-b border-l bg-muted p-2 text-left">Validation</th></tr><tr className="bg-muted/80">{columns.map(({ order }) => <th key={order.id} className="w-[280px] min-w-[280px] max-w-[280px] border-b border-l bg-muted/80 p-2 text-left"><div className="flex items-center justify-between gap-2"><span className="font-semibold">{order.number}</span><input type="checkbox" aria-label={`Select ${order.number} for approval`} checked={selectedApprovalIds.includes(order.id)} disabled={saving || dirtyUpdates.length > 0 || !isOrderApprovalEligible(order)} title={!isOrderApprovalEligible(order) ? "This order is incomplete or its shared stock pool is unverified/over-planned." : undefined} onChange={event => setSelectedApprovalIds(current => event.target.checked ? [...new Set([...current, order.id])] : current.filter(id => id !== order.id))} /></div><span className="block text-[11px] font-normal text-muted-foreground">{order.orderDate.slice(0, 10)} · {order.workflow}</span><Button className="mt-1 h-7 px-2 text-[11px]" size="sm" variant="outline" disabled={saving || dirtyUpdates.length > 0 || !isOrderApprovalEligible(order)} title={!isOrderApprovalEligible(order) ? "This order is incomplete or its shared stock pool is unverified/over-planned." : undefined} onClick={() => requestApproval([order.id])}>{isOrderFullyAllocated(order) ? "Approve → Consolidation" : "Allocate all lines first"}</Button></th>)}</tr></thead><tbody>
            {topSpacer > 0 && <tr><td colSpan={6 + columns.length} style={{ height: topSpacer, padding: 0, border: 0 }} /></tr>}
            {virtualRows.map(virtualRow => renderRow(rows[virtualRow.index], virtualRow.index))}
            {bottomSpacer > 0 && <tr><td colSpan={6 + columns.length} style={{ height: bottomSpacer, padding: 0, border: 0 }} /></tr>}
            {!rows.length && <tr><td colSpan={6 + columns.length} className="p-10 text-center text-muted-foreground">No matching products or orders.</td></tr>}
        </tbody></table></div>
        <OrderPagination pageIndex={safePageIndex} pageCount={pageCount} pageSize={pageSize} total={orders.length} onPage={setPageIndex} />
        {invalid && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">One or more allocations exceed the order quantity or reported stock. Check the affected rows.</p>}
         {operationError && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{operationError} Local edits were reverted to the last saved values. If rollback was incomplete, refresh and verify before retrying.</p>}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs"><span>{rows.length} products · {allRows.length} product/stock rows</span><span className="font-semibold">Preview total · all orders: ₱{totalAmount.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div className="sticky bottom-2 z-30 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur"><div className="min-w-48"><p className="text-sm font-semibold">Editing Draft allocations</p><p className="text-xs text-muted-foreground">{selectedApprovalIds.length} selected · {dirtyUpdates.length} unsaved · {eligibleSelected} selected eligible</p></div><div className="flex flex-wrap items-center gap-2"><Button variant="outline" disabled={!dirtyUpdates.length || saving} onClick={() => { setValues({ ...savedValues }); setFieldErrors({}); }}>Discard edits</Button><Button disabled={invalid || !dirtyUpdates.length || saving} onClick={savePlan}>{saving ? "Saving…" : `Save allocations (${dirtyUpdates.length})`}</Button><Button variant="secondary" disabled={!selectedApprovalIds.length || eligibleSelected !== selectedApprovalIds.length || dirtyUpdates.length > 0 || saving} title={selectedApprovalIds.length && eligibleSelected !== selectedApprovalIds.length ? "Select fully allocated eligible orders; save all edits first." : dirtyUpdates.length ? "Save pending changes before approval." : undefined} onClick={() => requestApproval(selectedApprovalIds)}><CheckCheck className="mr-2 h-4 w-4" />Approve selected ({selectedApprovalIds.length}) → For Consolidation</Button></div></div>
        <AlertDialog open={approvalPreviewIds.length > 0} onOpenChange={open => { if (!open && !saving) setApprovalPreviewIds([]); }}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Confirm allocation approval</AlertDialogTitle>
                    <AlertDialogDescription>Review the saved quantities and amounts below. Confirming moves these fully allocated orders to For Consolidation. Saved allocations do not reserve or decrement physical inventory.</AlertDialogDescription>
                </AlertDialogHeader>
                <div className="max-h-[50vh] space-y-3 overflow-y-auto">
                    {approvalPreviewOrders.map(order => <section key={order.id} className="rounded-md border p-3">
                        <div className="flex flex-wrap justify-between gap-2"><div><p className="font-semibold">{order.number}</p><p className="text-xs text-muted-foreground">{order.customer} · {order.orderDate.slice(0, 10)}</p></div><Badge variant="outline">Draft · fully allocated</Badge></div>
                        <ul className="mt-2 divide-y text-sm">{order.lines.map(line => {
                            const qty = values[line.id] ?? line.legacyAllocated;
                            const amount = allocationValue(line, qty);
                            return <li key={line.id} className="flex justify-between gap-3 py-1.5"><span className="min-w-0 truncate">{line.product} · {qty} {line.unit}</span><span className="shrink-0 font-medium">{amount === null ? "Amount unverified" : `₱${amount.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</span></li>;
                        })}</ul>
                    </section>)}
                </div>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={saving}>Review later</AlertDialogCancel>
                    <AlertDialogAction disabled={saving || dirtyUpdates.length > 0 || approvalPreviewOrders.length !== approvalPreviewIds.length || approvalPreviewOrders.some(order => !isOrderApprovalEligible(order))} onClick={event => { event.preventDefault(); void confirmApproval(); }}>{saving ? "Approving…" : "Confirm → For Consolidation"}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
     </div>;
}

function OrderPagination({ pageIndex, pageCount, pageSize, total, onPage }: { pageIndex: number; pageCount: number; pageSize: number; total: number; onPage: (page: number) => void }) {
    return <div className="flex items-center justify-between gap-3 text-sm"><span className="text-muted-foreground">{total ? `${pageIndex * pageSize + 1}–${Math.min((pageIndex + 1) * pageSize, total)} of ${total} orders` : "0 orders"} · Page {pageIndex + 1} of {pageCount}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={pageIndex === 0} onClick={() => onPage(pageIndex - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={pageIndex + 1 >= pageCount} onClick={() => onPage(pageIndex + 1)}>Next</Button></div></div>;
}
