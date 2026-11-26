"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCheck,
  PackageCheck,
  RefreshCw,
  Search,
  ShoppingCart,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useAllocationWorkspace } from "../hooks/useAllocationWorkspace";
import { quantity, quantityText } from "../domain/quantities";
import { canonicalUnit } from "../domain/units";
import { allocationProvider } from "../providers/allocationProvider";
import type {
  AllocationLine,
  AllocationOrder,
  AllocationSnapshot,
  ReportedInventory,
} from "../types";
import { Matrix } from "./AllocationMatrix";

type View = "product" | "order" | "review" | "matrix";
type ProductRow = {
  key: string;
  warehouseId: number;
  productId: number;
  supplierId: number | null;
  product: string;
  sku: string;
  unit: string;
  supplier: string;
};
type Draft = Record<number, string>;
type ProductMetric = {
  product: ProductRow;
  lines: { order: AllocationOrder; line: AllocationLine }[];
  stock: bigint | null;
  demand: bigint;
  planned: bigint;
  remaining: bigint | null;
};

const rowKey = (order: AllocationOrder, line: AllocationLine) =>
  `${order.warehouseId}:${line.productId}:${order.supplierId ?? "unknown"}:${canonicalUnit(line.unit)}`;
const stockWarehouseId = (stock: ReportedInventory) =>
  Number(
    stock.key.split(":")[0] === "demand"
      ? stock.key.split(":")[1]
      : stock.key.split(":")[0],
  );
export const orderStateLabel = (state: AllocationOrder["allocationState"]) =>
  state === "Legacy full"
    ? "Previously allocated"
    : state === "Legacy partial"
      ? "Partially allocated"
      : state;
const orderStateTone = (state: AllocationOrder["allocationState"]) =>
  state === "Legacy full"
    ? "border-slate-300 bg-slate-100 text-slate-700"
    : state === "Legacy partial"
      ? "border-blue-200 bg-blue-50 text-blue-800"
      : state === "Blocked"
        ? "border-red-200 bg-red-50 text-red-800"
        : "border-amber-200 bg-amber-50 text-amber-800";

export default function AllocationWorkspace() {
  const workspace = useAllocationWorkspace();
  const [view, setView] = useState<View>("order");
  if (workspace.loading && !workspace.snapshot)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading orders and inventory...
      </p>
    );
  if (workspace.error && !workspace.snapshot)
    return (
      <p role="alert" className="text-sm text-destructive">
        {workspace.error}
      </p>
    );
  if (!workspace.snapshot) return null;
  return (
    <Workspace
      snapshot={workspace.snapshot}
      warehouses={workspace.context?.warehouses || []}
      view={view}
      setView={setView}
      onRefresh={workspace.refresh}
    />
  );
}

function Workspace({
  snapshot,
  warehouses,
  view,
  setView,
  onRefresh,
}: {
  snapshot: AllocationSnapshot;
  warehouses: { id: number; name: string }[];
  view: View;
  setView: (view: View) => void;
  onRefresh: () => void;
}) {
  const initial = useMemo(
    () =>
      Object.fromEntries(
        snapshot.orders.flatMap((order) =>
          order.lines.map((line) => [line.id, line.legacyAllocated || "0"]),
        ),
      ) as Draft,
    [snapshot.orders],
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [saved, setSaved] = useState<Draft>(initial);
  const [selectedKey, setSelectedKey] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({});

  const products = useMemo(() => {
    const map = new Map<string, ProductRow>();
    snapshot.orders.forEach((order) =>
      order.lines.forEach((line) => {
        const key = rowKey(order, line);
        if (!map.has(key))
          map.set(key, {
            key,
            warehouseId: order.warehouseId,
            productId: line.productId,
            supplierId: order.supplierId,
            product: line.product,
            sku: line.sku,
            unit: line.unit,
            supplier: order.supplier,
          });
      }),
    );
    return [...map.values()];
  }, [snapshot.orders]);
  const inventory = useMemo(() => {
    const map = new Map<string, ReportedInventory[]>();
    snapshot.inventory.forEach((item) => {
      const key = `${stockWarehouseId(item)}:${item.productId}:${item.supplierId ?? "unknown"}:${canonicalUnit(item.unit)}`;
      map.set(key, [...(map.get(key) || []), item]);
    });
    return map;
  }, [snapshot.inventory]);
  const metrics = useMemo(
    () =>
      products.map((product) => {
        const lines = snapshot.orders.flatMap((order) =>
          order.lines
            .filter((line) => rowKey(order, line) === product.key)
            .map((line) => ({ order, line })),
        );
        const stockRows = inventory.get(product.key) || [];
        const stock =
          stockRows.length === 1 &&
          !stockRows[0].ambiguous &&
          stockRows[0].reportedStock !== null
            ? quantity(stockRows[0].reportedStock)
            : null;
        const demand = lines.reduce(
          (sum, item) => sum + quantity(item.line.ordered),
          0n,
        );
        const planned = lines.reduce(
          (sum, item) => sum + quantity(draft[item.line.id] || "0"),
          0n,
        );
        return {
          product,
          lines,
          stock,
          demand,
          planned,
          remaining: stock === null ? null : stock - planned,
        };
      }),
    [products, snapshot.orders, inventory, draft],
  );
  const filtered = metrics.filter((item) => {
    const text =
      `${item.product.product} ${item.product.sku} ${item.product.supplier}`.toLowerCase();
    const allocated = item.planned > 0n;
    return (
      (!search || text.includes(search.toLowerCase())) &&
      (status === "all" ||
        status ===
          (item.stock === null
            ? "unverified"
            : item.remaining !== null && item.remaining < 0n
              ? "short"
              : allocated && item.planned >= item.demand
                ? "full"
                : allocated
                  ? "partial"
                  : "needs"))
    );
  });
  const selected =
    metrics.find((item) => item.product.key === selectedKey) ||
    filtered[0] ||
    metrics[0];
  const dirty = Object.keys(draft).filter(
    (id) => (draft[Number(id)] || "0") !== (saved[Number(id)] || "0"),
  );
  const totalOrders = snapshot.orders.length;
  const issueCount = metrics.filter(
    (item) =>
      item.stock === null || (item.remaining !== null && item.remaining < 0n),
  ).length;
  const hasInvalidDraft = Object.values(fieldErrors).some(Boolean);
  const warehouseName = warehouses[0]?.name || "Warehouse - DRY22";

  function update(line: AllocationLine, value: string, pool: typeof selected) {
    value = value.replace(/^0+(?=\d)/, "");
    let message = "";
    try {
      if (!/^\d+(?:\.\d{1,6})?$/.test(value))
        message = "Enter a non-negative quantity with up to 6 decimal places.";
      else if (quantity(value) < quantity(line.served))
        message = `Cannot be below served quantity (${line.served}).`;
      else if (quantity(value) > quantity(line.ordered)) value = line.ordered;
      else if (pool.stock === null)
        message = "Inventory is unverified; refresh stock before allocating.";
      else if (pool.stock !== null) {
        const planned = pool.lines.reduce(
          (sum, item) =>
            sum +
            quantity(
              item.line.id === line.id ? value : draft[item.line.id] || "0",
            ),
          0n,
        );
        if (planned > pool.stock)
          message = `Shared stock limit is ${quantityText(pool.stock)} ${pool.product.unit}.`;
      }
    } catch {
      message = "Enter a valid quantity.";
    }
    setDraft((current) => ({ ...current, [line.id]: value }));
    setFieldErrors((current) => ({ ...current, [line.id]: message }));
    setError(message);
  }
  async function save() {
    const updates = dirty.flatMap((id) => {
      const detailId = Number(id);
      const owner = snapshot.orders.find((order) =>
        order.lines.some((line) => line.id === detailId),
      );
      return owner
        ? [{ orderId: owner.id, detailId, quantity: draft[detailId] || "0" }]
        : [];
    });
    if (!updates.length || Object.values(fieldErrors).some(Boolean)) return;
    setSaving(true);
    setError("");
    try {
      await allocationProvider.saveAllocations(updates);
      setSaved({ ...draft });
      setFieldErrors({});
      onRefresh();
      toast.success("Allocation plan saved");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Allocation save failed.",
      );
    } finally {
      setSaving(false);
    }
  }
  function orderEligible(order: AllocationOrder) {
    return order.lines.some(
      (line) =>
        quantity(draft[line.id] || "0") >= quantity(line.ordered) &&
        quantity(line.ordered) > 0n,
    );
  }
  async function approve(ids: number[]) {
    if (
      dirty.length ||
      !ids.length ||
      ids.some(
        (id) =>
          !orderEligible(snapshot.orders.find((order) => order.id === id)!),
      )
    )
      return;
    setSaving(true);
    setError("");
    try {
      await allocationProvider.approveAllocations(ids);
      toast.success("Orders moved to For Consolidation");
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Approval failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-w-0 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Sales Order Allocation
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Distribute reported warehouse stock across customer sales orders.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{warehouseName}</Badge>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => {
              if (
                !dirty.length ||
                window.confirm("Refresh and discard unsaved changes?")
              )
                onRefresh();
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </header>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi icon={ShoppingCart} label="Pending orders" value={totalOrders} />
        <Kpi icon={PackageCheck} label="Products" value={products.length} />
        <Kpi
          icon={AlertTriangle}
          label="Items needing attention"
          value={issueCount}
        />
        <Kpi
          icon={CheckCheck}
          label="Unsaved changes"
          value={`${dirty.length} lines`}
        />
      </div>
      <nav
        className="flex flex-wrap gap-2 border-b pb-3"
        aria-label="Allocation views"
      >
        {(
          [
            ["product", "By Product"],
            ["order", "By Sales Order"],
            ["review", "Review & Approve"],
            ["matrix", "Advanced Matrix"],
          ] as [View, string][]
        ).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={view === key ? "default" : "outline"}
            onClick={() => setView(key)}
          >
            {label}
          </Button>
        ))}
      </nav>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {view === "matrix" ? (
        <Matrix
          snapshot={snapshot}
          warehouses={warehouses}
          onRefresh={onRefresh}
        />
      ) : view === "product" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(250px,34%)_1fr]">
          <aside className="space-y-3 rounded-xl border p-3">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search product or SKU..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue placeholder="Allocation status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="needs">Needs allocation</SelectItem>
                <SelectItem value="partial">Partially allocated</SelectItem>
                <SelectItem value="full">Fully allocated</SelectItem>
                <SelectItem value="short">Insufficient stock</SelectItem>
                <SelectItem value="unverified">Inventory unverified</SelectItem>
              </SelectContent>
            </Select>
            <div className="max-h-[62vh] space-y-2 overflow-y-auto pr-1">
              {filtered.map((item) => (
                <ProductCard
                  key={item.product.key}
                  item={item}
                  selected={selected?.product.key === item.product.key}
                  onClick={() => setSelectedKey(item.product.key)}
                />
              ))}
              {!filtered.length && (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  No products match the current filters.
                </p>
              )}
            </div>
          </aside>
          <ProductDetail
            selected={selected}
            draft={draft}
            saved={saved}
            saving={saving}
            invalid={hasInvalidDraft}
            onUpdate={update}
            onDiscard={() => {
              setDraft({ ...saved });
              setFieldErrors({});
            }}
            onSave={save}
          />
        </div>
      ) : view === "order" ? (
        <OrderAllocationView
          snapshot={snapshot}
          metrics={metrics}
          draft={draft}
          saved={saved}
          search={search}
          setSearch={setSearch}
          saving={saving}
          onUpdate={update}
          onSave={save}
          onDiscard={() => {
            setDraft({ ...saved });
            setFieldErrors({});
          }}
          onApprove={approve}
        />
      ) : (
        <ReviewView
          snapshot={snapshot}
          draft={draft}
          saved={saved}
          dirty={dirty.length}
          saving={saving}
          onSave={save}
          onDiscard={() => {
            setDraft({ ...saved });
            setFieldErrors({});
          }}
          onApprove={approve}
        />
      )}
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof ShoppingCart;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-xs">{label}</span>
      </div>
      <strong className="mt-1 block text-xl">{value}</strong>
    </div>
  );
}
function ProductCard({
  item,
  selected,
  onClick,
}: {
  item: ProductMetric;
  selected: boolean;
  onClick: () => void;
}) {
  const full = item.planned >= item.demand;
  const label =
    item.stock === null
      ? "Inventory unverified"
      : item.remaining !== null && item.remaining < 0n
        ? "Insufficient stock"
        : full
          ? "Fully allocated"
          : item.planned > 0n
            ? "Partially allocated"
            : "Needs allocation";
  const tone =
    label === "Fully allocated"
      ? "border-green-200 bg-green-50 text-green-800"
      : label === "Partially allocated"
        ? "border-blue-200 bg-blue-50 text-blue-800"
        : label === "Needs allocation"
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : label === "Insufficient stock"
            ? "border-red-200 bg-red-50 text-red-800"
            : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-lg border p-3 text-left transition ${selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50"}`}
    >
      <div className="flex justify-between gap-2">
        <span className="font-semibold">{item.product.product}</span>
        <Badge variant="outline" className={tone}>
          {label}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        SKU {item.product.sku} · {item.product.unit}
      </p>
      <p className="mt-2 text-xs">
        {item.lines.length} customer order{item.lines.length === 1 ? "" : "s"} ·
        Demand {quantityText(item.demand)} · Planned{" "}
        {quantityText(item.planned)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {item.stock === null
          ? "Stock unavailable for verification"
          : `Reported stock: ${quantityText(item.stock)}`}
      </p>
    </button>
  );
}

function ProductDetail({
  selected,
  draft,
  saved,
  saving,
  invalid,
  onUpdate,
  onDiscard,
  onSave,
}: {
  selected: ProductMetric | undefined;
  draft: Draft;
  saved: Draft;
  saving: boolean;
  invalid: boolean;
  onUpdate: (line: AllocationLine, value: string, pool: ProductMetric) => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  if (!selected)
    return (
      <div className="rounded-xl border p-10 text-center text-muted-foreground">
        Select a product to review its competing orders.
      </div>
    );
  const hasDirty = Object.keys(draft).some(
    (id) => draft[Number(id)] !== saved[Number(id)],
  );
  return (
    <section className="flex min-h-0 max-h-[calc(100vh-13rem)] min-w-0 flex-col rounded-xl border">
      <div className="shrink-0 border-b p-5">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">
              {selected.product.product}
            </h2>
            <p className="text-sm text-muted-foreground">
              SKU {selected.product.sku} · {selected.product.unit} · Supplier:{" "}
              {selected.product.supplier || "Unknown"}
            </p>
          </div>
          <Badge variant="outline">Reported stock · not reserved</Badge>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            label="Reported stock"
            value={
              selected.stock === null
                ? "Unverified"
                : quantityText(selected.stock)
            }
          />
          <Metric label="Total demand" value={quantityText(selected.demand)} />
          <Metric label="Planned" value={quantityText(selected.planned)} />
          <Metric
            label="Remaining"
            value={
              selected.remaining === null
                ? "Unknown"
                : quantityText(selected.remaining)
            }
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Customer sales orders
        </h3>
        <div className="min-w-[640px] space-y-2">
          {selected.lines.map((item) => {
            const value = draft[item.line.id] || "0";
            const dirty = value !== (saved[item.line.id] || "0");
            const locked = selected.stock === null || item.line.quantityIssue;
            return (
              <div
                key={item.line.id}
                className="grid grid-cols-[1.5fr_.7fr_.7fr_1fr] items-center gap-3 rounded-lg border p-3"
              >
                <div>
                  <p className="font-medium">
                    {item.order.customer || "Unknown customer"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    SO: {item.order.number} ·{" "}
                    {item.order.salesman || "Salesman unavailable"}
                  </p>
                </div>
                <span className="text-sm">
                  {item.line.ordered} {item.line.unit}
                </span>
                <span className="text-sm text-muted-foreground">
                  Saved {saved[item.line.id] || "0"}
                </span>
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Allocation for ${item.order.number}`}
                    type="number"
                    min={item.line.served}
                    max={item.line.ordered}
                    step="any"
                    value={value}
                    disabled={saving || locked}
                    onChange={(event) =>
                      onUpdate(item.line, event.target.value, selected)
                    }
                    className={dirty ? "border-blue-400 bg-blue-50" : ""}
                  />
                  {dirty && <Badge variant="outline">Unsaved</Badge>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="sticky bottom-0 z-10 flex shrink-0 flex-wrap justify-end gap-2 border-t bg-background/95 p-4 shadow-[0_-4px_12px_rgba(0,0,0,.06)]">
        <Button
          variant="outline"
          disabled={!hasDirty || saving}
          onClick={onDiscard}
        >
          Discard changes
        </Button>
        <Button disabled={saving || !hasDirty || invalid} onClick={onSave}>
          {saving ? "Saving..." : "Save allocation plan"}
        </Button>
      </div>
    </section>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/50 p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="font-semibold">{value}</p>
    </div>
  );
}

function OrderAllocationView({
  snapshot,
  metrics,
  draft,
  saved,
  search,
  setSearch,
  saving,
  onUpdate,
  onSave,
  onDiscard,
  onApprove,
}: {
  snapshot: AllocationSnapshot;
  metrics: ProductMetric[];
  draft: Draft;
  saved: Draft;
  search: string;
  setSearch: (value: string) => void;
  saving: boolean;
  onUpdate: (line: AllocationLine, value: string, pool: ProductMetric) => void;
  onSave: () => void;
  onDiscard: () => void;
  onApprove: (ids: number[]) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [allocationFilter, setAllocationFilter] = useState("all");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const orders = snapshot.orders.filter(
    (order) =>
      (!search || `${order.number} ${order.customer} ${order.customerCode}`.toLowerCase().includes(search.toLowerCase())) &&
      (allocationFilter === "all" || order.allocationState === allocationFilter) &&
      (workflowFilter === "all" || order.workflow === workflowFilter) &&
      (supplierFilter === "all" || order.supplier === supplierFilter),
  );
  const order = orders.find((item) => item.id === selected) || orders[0];
  if (!order)
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(250px,34%)_1fr]">
        <aside className="space-y-3 rounded-xl border p-3">
          <Input placeholder="Search customer or order..." value={search} onChange={(event) => setSearch(event.target.value)} />
          <Select value={allocationFilter} onValueChange={setAllocationFilter}><SelectTrigger><SelectValue placeholder="Allocation status" /></SelectTrigger><SelectContent><SelectItem value="all">All allocation statuses</SelectItem><SelectItem value="Unallocated">Unallocated</SelectItem><SelectItem value="Legacy partial">Partially allocated</SelectItem><SelectItem value="Legacy full">Previously allocated</SelectItem><SelectItem value="Blocked">Blocked</SelectItem></SelectContent></Select>
          <Select value={workflowFilter} onValueChange={setWorkflowFilter}><SelectTrigger><SelectValue placeholder="Order workflow" /></SelectTrigger><SelectContent><SelectItem value="all">All order workflows</SelectItem>{[...new Set(snapshot.orders.map((item) => item.workflow).filter(Boolean))].map((workflow) => <SelectItem key={workflow} value={workflow}>{workflow}</SelectItem>)}</SelectContent></Select>
          <Select value={supplierFilter} onValueChange={setSupplierFilter}><SelectTrigger><SelectValue placeholder="Supplier" /></SelectTrigger><SelectContent><SelectItem value="all">All suppliers</SelectItem>{[...new Set(snapshot.orders.map((item) => item.supplier).filter(Boolean))].map((supplier) => <SelectItem key={supplier} value={supplier}>{supplier}</SelectItem>)}</SelectContent></Select>
          <Button variant="outline" className="w-full" onClick={() => { setSearch(""); setAllocationFilter("all"); setWorkflowFilter("all"); setSupplierFilter("all"); }}>Clear filters</Button>
        </aside>
        <section className="rounded-xl border p-10 text-center"><p className="font-medium">No orders match the selected filters.</p><p className="mt-1 text-sm text-muted-foreground">Clear one or more filters to show available sales orders.</p></section>
      </div>
    );
  const dirty = order.lines.some(
    (line) => (draft[line.id] || "0") !== (saved[line.id] || "0"),
  );
  const eligible = order.lines.some(
    (line) =>
      quantity(draft[line.id] || "0") >= quantity(line.ordered) &&
      quantity(line.ordered) > 0n,
  );
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(250px,34%)_1fr]">
      <aside className="space-y-3 rounded-xl border p-3">
        <Input
          placeholder="Search customer or order..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={allocationFilter} onValueChange={setAllocationFilter}>
            <SelectTrigger aria-label="Filter allocation status"><SelectValue placeholder="Allocation status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All allocation statuses</SelectItem>
              <SelectItem value="Unallocated">Unallocated</SelectItem>
              <SelectItem value="Legacy partial">Partially allocated</SelectItem>
              <SelectItem value="Legacy full">Previously allocated</SelectItem>
              <SelectItem value="Blocked">Blocked</SelectItem>
            </SelectContent>
          </Select>
          <Select value={workflowFilter} onValueChange={setWorkflowFilter}>
            <SelectTrigger aria-label="Filter order workflow"><SelectValue placeholder="Order workflow" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All order workflows</SelectItem>
              {[...new Set(snapshot.orders.map(order => order.workflow).filter(Boolean))].map(workflow => <SelectItem key={workflow} value={workflow}>{workflow}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={supplierFilter} onValueChange={setSupplierFilter}>
            <SelectTrigger aria-label="Filter supplier"><SelectValue placeholder="Supplier" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All suppliers</SelectItem>
              {[...new Set(snapshot.orders.map(order => order.supplier).filter(Boolean))].map(supplier => <SelectItem key={supplier} value={supplier}>{supplier}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="rounded-md border bg-muted/30 p-2 text-[11px]">
          <p className="mb-1 font-semibold text-muted-foreground">Status legend</p>
          <div className="flex flex-wrap gap-1.5">
            {(["Unallocated", "Partially allocated", "Previously allocated", "Blocked"] as const).map((label) => <Badge key={label} variant="outline" className={orderStateTone(label === "Previously allocated" ? "Legacy full" : label === "Partially allocated" ? "Legacy partial" : label === "Blocked" ? "Blocked" : "Unallocated")}>{label}</Badge>)}
          </div>
        </div>
        <div className="max-h-[62vh] space-y-2 overflow-y-auto">
          {orders.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => setSelected(item.id)}
              className={`w-full rounded-lg border p-3 text-left ${order.id === item.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
            >
              <p className="font-semibold">{item.number}</p>
              <p className="text-sm">{item.customer}</p>
              <Badge variant="outline" className={`mt-2 ${orderStateTone(item.allocationState)}`}>
                {orderStateLabel(item.allocationState)}
              </Badge>
            </button>
          ))}
        </div>
      </aside>
      <section className="flex min-h-0 max-h-[calc(100vh-13rem)] flex-col rounded-xl border">
        <div className="shrink-0 border-b p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{order.customer}</h2>
              <p className="text-sm text-muted-foreground">
                {order.number} · {order.salesman || "Salesman unavailable"} ·{" "}
                {order.workflow}
              </p>
            </div>
            <Badge variant="outline">
              {eligible ? "Fully allocated line" : "Incomplete"}
            </Badge>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Edit quantities below, save the allocation plan, then approve this
            order for consolidation once a line is fully allocated.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="space-y-2">
            {order.lines.map((line) => {
              const pool = metrics.find(
                (item) =>
                  item.product.key ===
                  `${order.warehouseId}:${line.productId}:${order.supplierId ?? "unknown"}:${canonicalUnit(line.unit)}`,
              );
              const value = draft[line.id] || "0";
              const isDirty = value !== (saved[line.id] || "0");
              const locked = !pool || pool.stock === null || line.quantityIssue;
              return (
                <div
                  key={line.id}
                  className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1.5fr_.7fr_.7fr_1fr]"
                >
                  <div>
                    <p className="font-medium">{line.product}</p>
                    <p className="text-xs text-muted-foreground">
                      SKU {line.sku} · {line.unit}
                    </p>
                  </div>
                  <span className="text-sm">{line.ordered} ordered</span>
                  <span className="text-sm text-muted-foreground">
                    Saved {saved[line.id] || "0"}
                  </span>
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={`Allocation for ${order.number} ${line.product}`}
                      type="number"
                      min={line.served}
                      max={line.ordered}
                      step="any"
                      value={value}
                      disabled={saving || locked}
                      onChange={(event) =>
                        pool && onUpdate(line, event.target.value, pool)
                      }
                    />
                    {isDirty && <Badge variant="outline">Unsaved</Badge>}
                  </div>
                  {locked && (
                    <p className="text-xs text-amber-700 sm:col-span-4">
                      {!pool || pool.stock === null
                        ? "Inventory is unverified for this product/UOM."
                        : "This line requires reconciliation before editing."}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="sticky bottom-0 z-10 flex flex-wrap justify-end gap-2 border-t bg-background/95 p-4 shadow-[0_-4px_12px_rgba(0,0,0,.06)">
          <Button
            variant="outline"
            disabled={!dirty || saving}
            onClick={onDiscard}
          >
            Discard changes
          </Button>
          <Button disabled={!dirty || saving} onClick={onSave}>
            Save allocation plan
          </Button>
          <Button
            variant="secondary"
            className="bg-green-600 text-white hover:bg-green-700 disabled:bg-green-200 disabled:text-green-700"
            disabled={!eligible || dirty || saving}
            onClick={() => onApprove([order.id])}
          >
            <CheckCheck className="mr-2 h-4 w-4" />
            Approve → Consolidation
          </Button>
        </div>
      </section>
    </div>
  );
}

function OrderView({
  snapshot,
  draft,
  saved,
  search,
  setSearch,
}: {
  snapshot: AllocationSnapshot;
  draft: Draft;
  saved: Draft;
  search: string;
  setSearch: (value: string) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const orders = snapshot.orders.filter(
    (order) =>
      !search ||
      `${order.number} ${order.customer} ${order.customerCode}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const order = orders.find((item) => item.id === selected) || orders[0];
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(250px,34%)_1fr]">
      <aside className="space-y-3 rounded-xl border p-3">
        <Input
          placeholder="Search customer or order..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="max-h-[62vh] space-y-2 overflow-y-auto">
          {orders.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => setSelected(item.id)}
              className={`w-full rounded-lg border p-3 text-left ${order?.id === item.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
            >
              <p className="font-semibold">{item.number}</p>
              <p className="text-sm">{item.customer}</p>
              <Badge variant="outline" className={`mt-2 ${orderStateTone(item.allocationState)}`}>
                {orderStateLabel(item.allocationState)}
              </Badge>
            </button>
          ))}
        </div>
      </aside>
      <section className="rounded-xl border p-5">
        {order ? (
          <>
            <h2 className="text-lg font-semibold">{order.customer}</h2>
            <p className="text-sm text-muted-foreground">
              {order.number} · {order.salesman || "Salesman unavailable"} ·{" "}
              {order.workflow}
            </p>
            <div className="mt-4 divide-y">
              {order.lines.map((line) => (
                <div key={line.id} className="flex justify-between gap-3 py-3">
                  <span>
                    {line.product}
                    <small className="block text-muted-foreground">
                      {line.sku} · {line.unit}
                    </small>
                  </span>
                  <span className="text-right">
                    {line.ordered} ordered
                    <small className="block text-muted-foreground">
                      {draft[line.id] || "0"} allocated · saved{" "}
                      {saved[line.id] || "0"}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">No orders found.</p>
        )}
      </section>
    </div>
  );
}

function ReviewView({
  snapshot,
  draft,
  saved,
  dirty,
  saving,
  onSave,
  onDiscard,
  onApprove,
}: {
  snapshot: AllocationSnapshot;
  draft: Draft;
  saved: Draft;
  dirty: number;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onApprove: (ids: number[]) => void;
}) {
  const eligible = snapshot.orders.filter((order) =>
    order.lines.some(
      (line) =>
        quantity(draft[line.id] || "0") >= quantity(line.ordered) &&
        quantity(line.ordered) > 0n,
    ),
  );
  return (
    <div className="space-y-5">
      <section className="rounded-xl border">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div>
            <h2 className="font-semibold">Allocation changes</h2>
            <p className="text-sm text-muted-foreground">
              {dirty} unsaved line{dirty === 1 ? "" : "s"}. Save before
              approval.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!dirty || saving}
              onClick={onDiscard}
            >
              Discard changes
            </Button>
            <Button disabled={!dirty || saving} onClick={onSave}>
              Save allocation plan
            </Button>
          </div>
        </div>
        <div className="divide-y">
          {snapshot.orders
            .flatMap((order) => order.lines.map((line) => ({ order, line })))
            .filter(
              (item) =>
                (draft[item.line.id] || "0") !== (saved[item.line.id] || "0"),
            )
            .map((item) => (
              <div
                key={item.line.id}
                className="grid grid-cols-[1.5fr_1fr_.7fr_.7fr] gap-3 p-3 text-sm"
              >
                <span>
                  {item.line.product}{" "}
                  <small className="block text-muted-foreground">
                    {item.order.number}
                  </small>
                </span>
                <span>{item.order.customer}</span>
                <span>{saved[item.line.id] || "0"}</span>
                <strong>{draft[item.line.id] || "0"}</strong>
              </div>
            ))}
          {!dirty && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No unsaved changes.
            </p>
          )}
        </div>
      </section>
      <section className="rounded-xl border">
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <h2 className="font-semibold">Orders eligible for consolidation</h2>
            <p className="text-sm text-muted-foreground">
              Eligibility requires at least one fully allocated line. Saved
              allocations do not reserve physical inventory.
            </p>
          </div>
          <Button
            disabled={!eligible.length || dirty > 0 || saving}
            onClick={() => onApprove(eligible.map((order) => order.id))}
          >
            <CheckCheck className="mr-2 h-4 w-4" />
            Approve eligible ({eligible.length})
          </Button>
        </div>
        <div className="divide-y">
          {snapshot.orders.map((order) => (
            <div
              key={order.id}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <span>
                <strong>{order.number}</strong>
                <small className="ml-2 text-muted-foreground">
                  {order.customer}
                </small>
              </span>
              <Badge variant="outline">
                {eligible.some((item) => item.id === order.id)
                  ? "Fully allocated line"
                  : "Incomplete"}
              </Badge>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
