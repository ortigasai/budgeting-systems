import { QueryClient } from "@tanstack/react-query";

// Hoisted out of main.tsx so uploadManager.ts (a plain module, not a React
// hook) can also invalidate queries after a background upload finishes.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 10_000,
    },
  },
});
