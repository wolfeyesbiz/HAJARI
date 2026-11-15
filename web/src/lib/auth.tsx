import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, SessionUser } from './api';

interface MeResponse {
  user: SessionUser;
  student?: { roll_no: string; semester: number; section: string; class_name: string; department_code: string };
  staff?: { staff_code: string; designation: string; employment_type: string };
  assignments?: Array<{
    class_id: number;
    class_name: string;
    semester: number;
    section: string;
    subject_id: number;
    subject_code: string;
    subject_name: string;
    department_id: number;
    department_code: string;
    department_name: string;
  }>;
  system: { smsDriver: string; smsConfigured: boolean };
}

interface AuthCtx {
  me: MeResponse | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  me: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api<MeResponse>('/auth/me');
      setMe(data);
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      await api('/auth/login', { json: { email, password } });
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setMe(null);
    }
  }, []);

  const value = useMemo(() => ({ me, loading, login, logout, refresh }), [me, loading, login, logout, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}
