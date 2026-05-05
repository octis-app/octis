import { useState, useEffect, useCallback } from 'react'

const API_BASE = (import.meta as any).env?.VITE_API_URL || ''

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
  return outputArray
}

export type PushStatus = 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed' | 'loading'

export function usePushNotifications(getToken: () => Promise<string | null>) {
  const [status, setStatus] = useState<PushStatus>('loading')

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setStatus('unsupported')
      return
    }
    if (Notification.permission === 'denied') {
      setStatus('denied')
      return
    }
    navigator.serviceWorker.ready.then(reg => {
      reg.pushManager.getSubscription().then(sub => {
        setStatus(sub ? 'subscribed' : 'unsubscribed')
      })
    })
  }, [])

  const subscribe = useCallback(async () => {
    if (!('serviceWorker' in navigator)) return
    try {
      setStatus('loading')
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') { setStatus('denied'); return }

      // Get VAPID public key from server
      const keyRes = await fetch(`${API_BASE}/api/push/vapid-public-key`)
      const { key } = await keyRes.json()

      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      })

      
      await fetch(`${API_BASE}/api/push/subscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          credentials: 'include',
        },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          userAgent: navigator.userAgent,
        }),
      })
      setStatus('subscribed')
    } catch (e) {
      console.error('[push] Subscribe failed:', e)
      setStatus('unsubscribed')
    }
  }, [getToken])

  const unsubscribe = useCallback(async () => {
    try {
      setStatus('loading')
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        
        await fetch(`${API_BASE}/api/push/unsubscribe`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            credentials: 'include',
          },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        })
        await sub.unsubscribe()
      }
      setStatus('unsubscribed')
    } catch (e) {
      console.error('[push] Unsubscribe failed:', e)
    }
  }, [getToken])

  return { status, subscribe, unsubscribe }
}
