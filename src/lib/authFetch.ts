/**
 * authFetch — credentials-aware fetch wrapper.
 * Automatically dispatches 'octis-unauthorized' on 401 so App.tsx
 * can surface the login modal without every call-site needing to handle it.
 */
export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, {
    credentials: 'include',
    ...init,
  })
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('octis-unauthorized'))
  }
  return res
}
