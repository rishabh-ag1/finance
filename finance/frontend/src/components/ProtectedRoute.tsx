import { Navigate, Outlet } from 'react-router';
import { useAuth } from '../context/auth';

interface ProtectedRouteProps {
    requiredModule?: string;
    requiredAction?: string;
}

/** Wraps the signed-in routes; specific routes can demand a permission (same as Bloc's CRM). */
export function ProtectedRoute({ requiredModule, requiredAction }: ProtectedRouteProps) {
    const { isAuthenticated, isLoading, hasPermission } = useAuth();

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
                <div className="w-6 h-6 border-2 border-gray-300 border-t-[#0c2c55] rounded-full animate-spin" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return <Navigate to="/login" replace />;
    }

    if (requiredModule && requiredAction && !hasPermission(requiredModule, requiredAction)) {
        return <Navigate to="/" replace />;
    }

    return <Outlet />;
}
