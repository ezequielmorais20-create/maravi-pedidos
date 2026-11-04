import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post } from './api';

export interface User { id: string; name: string; email: string; phone: string | null; role: string; permissions: string[] }
interface Ctx {
  user: User | null;
  loading: boolean;
  login(email: string, password: string): Promise<User>;
  register(b: { name: string; email: string; phone?: string; password: string }): Promise<User>;
  logout(): Promise<void>;
  can(p: string): boolean;
  isStaff: boolean;
}
const AuthCtx = createContext<Ctx>(null as never);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    get<{ user: User | null }>('/api/auth/me').then((r) => setUser(r.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);
  const login = useCallback(async (email: string, password: string) => {
    const r = await post<{ user: User }>('/api/auth/login', { email, password });
    setUser(r.user);
    return r.user;
  }, []);
  const register = useCallback(async (b: { name: string; email: string; phone?: string; password: string }) => {
    const r = await post<{ user: User }>('/api/auth/register', b);
    setUser(r.user);
    return r.user;
  }, []);
  const logout = useCallback(async () => {
    await post('/api/auth/logout').catch(() => undefined);
    setUser(null);
  }, []);
  const can = useCallback((p: string) => !!user?.permissions.includes(p), [user]);
  return <AuthCtx.Provider value={{ user, loading, login, register, logout, can, isStaff: !!user && user.role !== 'cliente' }}>{children}</AuthCtx.Provider>;
}
