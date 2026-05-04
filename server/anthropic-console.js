/**
 * anthropic-console.js — Fetch usage data from Anthropic Console API
 * 
 * Uses session cookies to authenticate with console.anthropic.com
 * and fetch real-time cost/usage data.
 */

export async function fetchAnthropicUsage(sessionCookie) {
  if (!sessionCookie) {
    throw new Error('No Anthropic session cookie configured')
  }

  // The Anthropic Console API endpoint for usage/billing
  const usageUrl = 'https://console.anthropic.com/api/organizations/usage'
  
  try {
    const response = await fetch(usageUrl, {
      headers: {
        'Cookie': sessionCookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    })

    if (!response.ok) {
      throw new Error(`Anthropic Console API returned ${response.status}`)
    }

    const data = await response.json()
    
    // Transform the Console API response into Octis format
    return transformAnthropicData(data)
  } catch (error) {
    console.error('[anthropic-console] Failed to fetch usage:', error.message)
    throw error
  }
}

function transformAnthropicData(raw) {
  // TODO: Adjust this based on actual Anthropic Console API response structure
  // This is a placeholder - we need to inspect the real API response first
  
  return {
    today: raw.usage?.today?.cost_usd || 0,
    yesterday: raw.usage?.yesterday?.cost_usd || 0,
    thisMonth: raw.usage?.this_month?.cost_usd || 0,
    lastMonth: raw.usage?.last_month?.cost_usd || 0,
    daily: raw.usage?.daily || [],
    sessions: raw.sessions || [],
    lastSync: new Date().toISOString(),
  }
}

export function saveAnthropicSession(db, userId, sessionCookie) {
  // Store the session cookie securely
  db.prepare(`
    INSERT INTO user_settings (user_id, key, value)
    VALUES (?, 'anthropic_session_cookie', ?)
    ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `).run(userId, sessionCookie)
}

export function getAnthropicSession(db, userId) {
  const row = db.prepare(`
    SELECT value FROM user_settings WHERE user_id = ? AND key = 'anthropic_session_cookie'
  `).get(userId)
  
  return row?.value || null
}
