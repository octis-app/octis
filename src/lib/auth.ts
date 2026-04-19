// Local auth shim — replaces @clerk/clerk-react
// Cookie-based auth: credentials: 'include' on fetch is sufficient
// getToken() returns null; server reads httpOnly cookie automatically

export function useAuth() {
  return {
    getToken: async (): Promise<string | null> => null,
    isSignedIn: true,
    isLoaded: true,
  }
}
