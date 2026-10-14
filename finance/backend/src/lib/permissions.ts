/**
 * Finance permission modules, stored in Role.permissions the same way Bloc does
 * ({ module: { action: true } }). Keys are prefixed "finance" so they can sit next to the
 * CRM's keys (leads, orders, users...) in one Role row when the apps are merged.
 */
export const FINANCE_MODULES = {
    financeHome: 'Home dashboard',
    financeSettings: 'Settings and masters',
    financeBank: 'Bank import and ledger',
    financeRules: 'Categorisation rules',
    financeVendors: 'Vendors',
    financePurchases: 'Purchase orders',
    financeBills: 'Vendor bills',
    financePayments: 'Payments out',
    financeTds: 'TDS',
    financeClaims: 'Founder expense claims',
    financeDocuments: 'Documents vault',
    financeUsers: 'Users and roles',
    financeAudit: 'Audit log',
} as const;

export type FinanceModule = keyof typeof FINANCE_MODULES;
export type PermissionAction = 'view' | 'edit';
export type RolePermissions = Partial<Record<string, Partial<Record<PermissionAction, boolean>>>>;

/** Full access to every finance module (the founders' role in v1, Q18). */
export function adminPermissions(): RolePermissions {
    return Object.fromEntries(
        Object.keys(FINANCE_MODULES).map((m) => [m, { view: true, edit: true }]),
    );
}
