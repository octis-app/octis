// Push notification handler — injected into service worker
self.addEventListener('push', (event) => {
  let data = { title: 'Octis', body: 'Byte needs your input.' }
  try {
    if (event.data) data = { ...data, ...event.data.json() }
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'octis-agent',
      renotify: true,
      data: data.data || {},
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus()
        }
      }
      if (clients.openWindow) return clients.openWindow('/')
    })
  )
})
