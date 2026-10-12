import { useState, useEffect, useCallback, type ReactNode } from 'react';
import api from '../api';
import { AuthContext, type AuthUser } from './auth';

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const loadMe = useCallback(
        () => api.get<{ success: boolean; data: AuthUser }>('/auth/me').then((res) => res.data.data, () => null),
        []
    );

    const fetchUser = useCallback(async () => {
        setUser(await loadMe());
        setIsLoading(false);
    }, [loadMe]);

    useEffect(() => {
        let alive = true;
        loadMe().then((me) => {
            if (!alive) return;
            setUser(me);
            setIsLoading(false);
        });
        return () => { alive = false; };
    }, [loadMe]);

    const logout = useCallback(async () => {
        try {
            await api.post('/auth/logout');
        } catch {
            // Ignore logout errors
        } finally {
            setUser(null);
        }
    }, []);

    const hasPermission = useCallback(
        (module: string, action: string): boolean => user?.role?.permissions?.[module]?.[action] === true,
        [user]
    );

    return (
        <AuthContext.Provider
            value={{
                user,
                isLoading,
                isAuthenticated: !!user,
                logout,
                refetchUser: fetchUser,
                hasPermission,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}
