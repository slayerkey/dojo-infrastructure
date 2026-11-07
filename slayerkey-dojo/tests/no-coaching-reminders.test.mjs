import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("coaching-call announcements are unreachable from the active scheduled chain", () => {
  const v42 = source("../src/index-v42.js");
  const v43 = source("../src/index-v43.js");
  const v44 = source("../src/index-v44.js");
  const v45 = source("../src/index-v45.js");
  const config = source("../wrangler.jsonc");

  assert.match(config, /"main":\s*"src\/index-v45\.js"/);
  assert.match(v45, /import legacy.*from "\.\/index-v44\.js"/);
  assert.match(v44, /import legacy.*from "\.\/index-v43\.js"/);
  assert.match(v43, /import legacy.*from "\.\/index-v42\.js"/);
  assert.match(v42, /import legacy.*from "\.\/index-v41\.js"/);
  assert.doesNotMatch(v42, /coaching-reminders|runCoachingReminderScheduler|claimCoachingReminder|releaseCoachingReminder|scheduled-events|@everyone/);
  assert.match(v42, /await legacy\.scheduled\(controller, env, ctx\)/);
  assert.match(v45, /coaching_reminder\s*=\s*\{[\s\S]*?scheduled:\s*false/);
});
