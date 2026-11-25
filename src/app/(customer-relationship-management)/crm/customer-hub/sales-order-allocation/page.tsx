import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { NavUser } from "@/components/shared/app-sidebar/nav-user";
import { cookies } from "next/headers";
import SalesOrderAllocationModule from "@/modules/customer-relationship-management/customer-hub/sales-order-allocation/components/AllocationMatrix";

export const dynamic = "force-dynamic";

function decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
        const encoded = token.split(".")[1];
        if (!encoded) return null;
        const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch { return null; }
}

function headerUser(token: string | null) {
    const payload = token ? decodeJwtPayload(token) : null;
    const value = (keys: string[]) => keys.map(key => payload?.[key]).find((item): item is string => typeof item === "string" && Boolean(item.trim()))?.trim() || "";
    const email = value(["email", "Email"]);
    return { name: [value(["Firstname", "FirstName", "firstName", "firstname", "first_name"]), value(["LastName", "Lastname", "lastName", "lastname", "last_name"])].filter(Boolean).join(" ") || email || "User", email, avatar: "/avatars/shadcn.jpg" };
}

export default async function Page() {
    const token = (await cookies()).get("vos_access_token")?.value ?? null;
    return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="relative z-10 flex h-14 shrink-0 items-center justify-between overflow-hidden border-b bg-background shadow-sm sm:h-16">
            <div className="flex h-full min-w-0 items-center gap-2 overflow-hidden px-3 sm:px-4">
                <SidebarTrigger className="-ml-1 shrink-0" /><Separator orientation="vertical" className="mr-2 hidden h-4 sm:block" />
                <Breadcrumb><BreadcrumbList className="min-w-0 overflow-hidden"><BreadcrumbItem className="hidden shrink-0 md:block"><BreadcrumbLink href="#">Customer Hub</BreadcrumbLink></BreadcrumbItem><BreadcrumbSeparator className="hidden shrink-0 md:block" /><BreadcrumbItem className="min-w-0 overflow-hidden"><BreadcrumbPage className="max-w-[56vw] truncate sm:max-w-[60vw] md:max-w-none">Sales Order Allocation</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
            </div>
            <div className="flex h-full shrink-0 items-center overflow-hidden px-2 sm:px-4"><NavUser user={headerUser(token)} /></div>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-6 sm:p-8"><SalesOrderAllocationModule /></main>
    </div>;
}
