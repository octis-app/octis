# Octis 🐙

> One brain. Many arms.

**Octis** is an open-source command center for power users of AI agents. Stop losing time re-orienting between sessions — see all your active workstreams at a glance, reply from anywhere, and never lose context.

Built for [OpenClaw](https://github.com/openclaw/openclaw) users. Protocol-agnostic by design.

---

## The problem

If you run 10+ AI sessions a day across multiple projects, you know the pain:
- Which sessions are still active?
- What was the last decision we made?
- What are my next actions on this project?
- How much has this session cost me so far?

Switching between Slack threads or terminal windows burns 30% of your day just re-orienting.

## The solution

Octis gives you a mission control interface:

### Desktop
- Up to 5 concurrent sessions visible side-by-side
- Per-session sidebar: project brief, current plan, live todos
- 3-monitor support
- Session status: active / idle / blocked / dead
- Cost per session

### Mobile
- Swipeable card carousel (one card per active session)
- Inline reply without opening the full thread
- Bottom nav: All · Active · Memory · Costs

### Memory feed
- What got committed to memory this week
- Which sessions produced decisions
- Jump back to any session from a memory entry

---

## Status

🚧 **Early planning / pre-alpha**

The spec is being written. Contributions and feedback welcome.

---

## Tech stack (planned)

- React + Vite (PWA)
- Tailwind CSS
- OpenClaw Gateway WebSocket API
- Node.js backend (optional, for memory file access)

---

## Contributing

This is day one. If you're an OpenClaw power user and this resonates, open an issue or start a discussion.

---

## License

MIT
