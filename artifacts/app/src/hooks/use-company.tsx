import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";

export interface Company {
  id: number;
  name: string;
  createdAt?: string;
}

interface CompanyContextValue {
  companyId: number;
  setCompanyId: (id: number) => void;
  companies: Company[];
  isLoading: boolean;
}

const STORAGE_KEY = "tp.selectedCompanyId";

// Default to 1: the "Default Company" always exists, so every data fetcher has a
// valid id from the very first render, before the company list has loaded.
const DEFAULT_COMPANY_ID = 1;

function readStoredId(): number {
  if (typeof window === "undefined") return DEFAULT_COMPANY_ID;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMPANY_ID;
}

const CompanyContext = createContext<CompanyContextValue | null>(null);

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [companyId, setCompanyIdState] = useState<number>(readStoredId);

  const { data: companies = [], isLoading } = useQuery<Company[]>({
    queryKey: ["companies"],
    queryFn: async () => {
      const res = await fetch("/api/pipeline/companies");
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const setCompanyId = useCallback((id: number) => {
    setCompanyIdState(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, String(id));
    }
  }, []);

  // If the stored/selected company isn't in the loaded list (e.g. it was
  // deleted, or localStorage is stale), fall back to the first real company so
  // the switcher never points at a non-existent id (the API 500s on those).
  const resolvedId = useMemo(() => {
    if (companies.length === 0) return companyId;
    return companies.some((c) => c.id === companyId) ? companyId : companies[0]!.id;
  }, [companies, companyId]);

  const value = useMemo<CompanyContextValue>(
    () => ({ companyId: resolvedId, setCompanyId, companies, isLoading }),
    [resolvedId, setCompanyId, companies, isLoading]
  );

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompany(): CompanyContextValue {
  const ctx = useContext(CompanyContext);
  if (!ctx) throw new Error("useCompany must be used within a CompanyProvider");
  return ctx;
}

// Convenience: most call sites only need the id.
export function useCompanyId(): number {
  return useCompany().companyId;
}
