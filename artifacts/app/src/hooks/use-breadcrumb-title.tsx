import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * Lets a detail page tell the layout what to call itself in the breadcrumb.
 *
 * Without this, AppLayout's Breadcrumbs falls back to the raw path segment, so
 * /radar/trends/61 renders "Radar > Trends > 61" — a database id shown to the
 * client. The layout cannot know the title on its own: only the page that
 * loaded the record has it.
 *
 * Deliberately a context rather than having Breadcrumbs read react-query's
 * cache: that would hard-code the detail page's query key into the layout, and
 * getQueryData is not reactive, so the crumb would keep showing the id until
 * something else forced a re-render.
 */
type Ctx = {
  title: string | null;
  setTitle: (t: string | null) => void;
};

const BreadcrumbTitleContext = createContext<Ctx>({
  title: null,
  setTitle: () => {},
});

export function BreadcrumbTitleProvider({ children }: { children: React.ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const value = useMemo(() => ({ title, setTitle }), [title]);
  return (
    <BreadcrumbTitleContext.Provider value={value}>
      {children}
    </BreadcrumbTitleContext.Provider>
  );
}

export function useBreadcrumbTitleValue(): string | null {
  return useContext(BreadcrumbTitleContext).title;
}

/**
 * Publish a title for the current page. Pass undefined/null while loading —
 * the breadcrumb falls back to the path segment until a real title arrives.
 *
 * Clears on unmount so navigating away can never leave the previous page's
 * title stranded in the crumb.
 */
export function usePublishBreadcrumbTitle(title: string | null | undefined) {
  const { setTitle } = useContext(BreadcrumbTitleContext);
  const stable = useCallback(setTitle, [setTitle]);
  useEffect(() => {
    stable(title ?? null);
    return () => stable(null);
  }, [title, stable]);
}
