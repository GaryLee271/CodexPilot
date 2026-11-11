import assert from "node:assert/strict";
import { test } from "node:test";
import { managerNavigationDestination } from "./enhancement-navigation.ts";

test("manager links open the requested page without retired sections", () => {
  for (const page of ["settings", "enhance"] as const) {
    const intent = { page };
    assert.deepEqual(managerNavigationDestination(intent), { route: page });
    assert.deepEqual(intent, { page });
  }
});
