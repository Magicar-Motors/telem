import assert from "node:assert/strict";
import test from "node:test";
import {
  sceneGroups,
  switchScene,
  vendorCall,
  VENDOR,
} from "../lib/scenes.mjs";

test("includes every (Vertical) main scene and all plugin scenes without duplicates", () => {
  assert.deepEqual(
    sceneGroups(
      ["Main", "Camera (Vertical)", "BRB (vertical)"],
      ["Camera (Vertical)", "Portrait"],
    ),
    {
      horizontal: ["Main"],
      vertical: [
        { name: "Camera (Vertical)", available: true },
        { name: "Portrait", available: true },
        { name: "BRB (vertical)", available: false },
      ],
    },
  );
});
test("horizontal changes target only the main program", async () => {
  const calls = [];
  await switchScene(
    {
      call: async (type, data) => {
        calls.push([type, data]);
        return { currentProgramSceneName: "Main" };
      },
    },
    "horizontal",
    "Main",
    async () => {},
  );
  assert.deepEqual(calls[0], ["SetCurrentProgramScene", { sceneName: "Main" }]);
  assert.equal(calls.length, 2);
});
test("vertical change uses Restream vendor and waits for actual active scene", async () => {
  const calls = [];
  let reads = 0;
  await switchScene(
    {
      call: async (type, data) => {
        assert.equal(type, "CallVendorRequest");
        assert.equal(data.vendorName, VENDOR);
        calls.push(data);
        return {
          responseData: {
            success: true,
            scenes: [{ name: "Camera (Vertical)" }],
            scene: ++reads > 3 ? "Camera (Vertical)" : "Old",
          },
        };
      },
    },
    "vertical",
    "Camera (Vertical)",
    async () => {},
  );
  assert.deepEqual(calls[1].requestData, { scene: "Camera (Vertical)" });
  assert.equal(calls[1].requestType, "switch_scene");
  assert.ok(calls.length >= 4);
});
test("unregistered scenes cannot change either output", async () => {
  const calls = [];
  await assert.rejects(
    switchScene(
      {
        call: async (type, data) => {
          calls.push(data.requestType);
          return { responseData: { success: true, scenes: [] } };
        },
      },
      "vertical",
      "Missing (Vertical)",
      async () => {},
    ),
    /not in the Restream/,
  );
  assert.deepEqual(calls, ["get_scenes"]);
});
test("plugin-level errors are not treated as success", async () => {
  await assert.rejects(
    vendorCall(
      {
        call: async () => ({
          responseData: { success: false, error: "Plugin error" },
        }),
      },
      "current_scene",
    ),
    /Plugin error/,
  );
});
test("silent vendor no-op fails confirmation", async () => {
  await assert.rejects(
    switchScene(
      {
        call: async () => ({
          responseData: {
            success: true,
            scenes: [{ name: "New" }],
            scene: "Old",
          },
        }),
      },
      "vertical",
      "New",
      async () => {},
    ),
    /did not confirm/,
  );
});
