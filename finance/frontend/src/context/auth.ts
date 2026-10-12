import { createContext, useContext } from 'react';

export type RolePermissions = Record<string, Record<string, boolean>>;

export type AuthRole = {
    id: string;
    name: string;
    permissions: RolePermissions;
};

export type AuthUser = {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    role: AuthRole | null;
};

export type AuthContextValue = {
    user: AuthUser | null;
    isLoading: boolean;
    isAuthenticated: boolean;
    logout: () => Promise<void>;
    refetchUser: () => Promise<void>;
    hasPermission: (module: string, action: string) => boolean;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}
