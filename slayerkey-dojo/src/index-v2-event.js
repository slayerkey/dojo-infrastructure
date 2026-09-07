import legacy from "./index-v2.js";

// Preserve all legacy HTTP/interaction/webhook behavior, but intentionally stop
// the v2 scheduled full-company Whop reconciliation. Membership access changes
// are already event-driven through /whop/webhook, and /verify-all remains the
// explicit recovery tool if a full reconciliation is ever needed.
export default {
  async fetch(request, env, ctx) {
    return legacy.fetch(request, env, ctx);
  },

  async scheduled() {
    return;
  },
};
