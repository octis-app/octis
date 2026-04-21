// Local auth shim — replaces @clerk/clerk-react
// Cookie-based auth: credentials: 'include' on fetch is sufficient
// getToken() returns null; server reads httpOnly cookie automatically

// Stable reference outside the hook — prevents useCallback/useEffect
// from re-firing on every render when getToken is in a dep array
const stableGetToken = async (): Promise<string | null> => null

export function useAuth() {
  return {
    getToken: stableGetToken,
    isSignedIn: true,
    isLoaded: true,
  }
}
