import assert from "node:assert/strict";
import test from "node:test";
import {
  verticalState,
  switchVerticalSource,
  rotatedPortraitTransform,
} from "../lib/vertical.mjs";

function fake({
  missing = false,
  failDisable = false,
  failTransform = false,
  fallback = false,
} = {}) {
  const calls = [];
  const transform = {
    positionX: 40,
    positionY: 70,
    rotation: 270,
    scaleX: 1,
    scaleY: 1,
    boundsType: "OBS_BOUNDS_NONE",
  };
  const items = [
    {
      sceneItemId: 1,
      sourceUuid: "a",
      sourceName: "A (Vertical)",
      sceneItemEnabled: true,
      sceneItemTransform: transform,
    },
    {
      sceneItemId: 9,
      sourceUuid: "overlay",
      sourceName: "Logo",
      sceneItemEnabled: true,
    },
  ];
  const obs = {
    call: async (type, data) => {
      calls.push([type, data]);
      if (type === "GetSceneList")
        return {
          scenes: data?.canvasUuid
            ? missing
              ? []
              : [{ sceneUuid: "wrapper", sceneName: "Vertical Output" }]
            : [
                { sceneUuid: "a", sceneName: "A (Vertical)" },
                {
                  sceneUuid: "b",
                  sceneName: fallback ? "BC - Unpaired" : "B (Vertical)",
                },
              ],
        };
      if (type === "GetCanvasList")
        return {
          canvases: [
            {
              canvasUuid: "canvas",
              canvasName: "Restream Vertical",
              canvasFlags: { MAIN: false },
              canvasVideoSettings: { baseWidth: 1080, baseHeight: 1920 },
            },
          ],
        };
      if (type === "CallVendorRequest")
        return {
          responseData: {
            success: true,
            scenes: [{ name: "Vertical Output" }],
            scene: "Vertical Output",
          },
        };
      if (type === "GetSceneItemList")
        return { sceneItems: structuredClone(items) };
      if (type === "CreateSceneItem") {
        items.push({
          sceneItemId: 2,
          sourceUuid: "b",
          sourceName: fallback ? "BC - Unpaired" : "B (Vertical)",
          sceneItemEnabled: false,
          sceneItemTransform: {},
        });
        return { sceneItemId: 2 };
      }
      if (type === "SetSceneItemTransform") {
        if (failTransform) throw Error("Transform failed");
        items.find(
          (i) => i.sceneItemId === data.sceneItemId,
        ).sceneItemTransform = data.sceneItemTransform;
        return {};
      }
      if (type === "RemoveSceneItem") {
        items.splice(
          items.findIndex((i) => i.sceneItemId === data.sceneItemId),
          1,
        );
        return {};
      }
      if (type === "SetSceneItemEnabled") {
        if (failDisable && data.sceneItemId === 1 && !data.sceneItemEnabled)
          throw Error("Visibility failed");
        items.find((i) => i.sceneItemId === data.sceneItemId).sceneItemEnabled =
          data.sceneItemEnabled;
        return {};
      }
      throw Error(`Unexpected request ${type}`);
    },
  };
  return { obs, calls, items, transform };
}
test("reads nested source visibility as the active vertical selection", async () => {
  const f = fake();
  assert.equal((await verticalState(f.obs)).active, "A (Vertical)");
});
test("adds a disabled reference, copies framing, and toggles only managed sources", async () => {
  const f = fake();
  await switchVerticalSource(f.obs, "B (Vertical)", async () => {});
  assert.equal((await verticalState(f.obs)).active, "B (Vertical)");
  assert.equal(f.items.find((i) => i.sceneItemId === 9).sceneItemEnabled, true);
  assert.deepEqual(
    f.items.find((i) => i.sceneItemId === 2).sceneItemTransform,
    f.transform,
  );
  assert.equal(
    f.calls.find(([t]) => t === "CreateSceneItem")[1].sceneItemEnabled,
    false,
  );
  assert.ok(
    !f.calls.some(([t]) =>
      ["CreateScene", "SetCurrentProgramScene"].includes(t),
    ),
  );
});
test("reuses existing references and preserves their transforms", async () => {
  const f = fake();
  await switchVerticalSource(f.obs, "A (Vertical)", async () => {});
  assert.ok(
    !f.calls.some(([t]) =>
      ["CreateSceneItem", "SetSceneItemTransform"].includes(t),
    ),
  );
});
test("missing manual wrapper fails before making changes", async () => {
  const f = fake({ missing: true });
  await assert.rejects(
    switchVerticalSource(f.obs, "B (Vertical)"),
    /Create a scene/,
  );
  assert.ok(
    !f.calls.some(([t]) => t.startsWith("Set") || t.startsWith("Create")),
  );
});
test("partial visibility failure restores the previous selection", async () => {
  const f = fake({ failDisable: true });
  await assert.rejects(
    switchVerticalSource(f.obs, "B (Vertical)"),
    /Visibility failed/,
  );
  assert.equal((await verticalState(f.obs)).active, "A (Vertical)");
});
test("failed framing removes only the newly created source reference", async () => {
  const f = fake({ failTransform: true });
  await assert.rejects(
    switchVerticalSource(f.obs, "B (Vertical)"),
    /Transform failed/,
  );
  assert.equal(f.items.length, 2);
  assert.equal(f.items[0].sceneItemEnabled, true);
});
test("fallback uses the horizontal source, rotated and fitted, and disables the previous portrait", async () => {
  const f = fake({ fallback: true });
  await switchVerticalSource(f.obs, "BC - Unpaired", async () => {});
  assert.equal((await verticalState(f.obs)).active, "BC - Unpaired");
  const t = f.items.find((i) => i.sceneItemId === 2).sceneItemTransform;
  assert.equal(t.rotation, 90);
  assert.equal(t.boundsWidth, 1920);
  assert.equal(t.boundsHeight, 1080);
  assert.equal(t.positionX, 540);
  assert.equal(t.positionY, 960);
  assert.equal(t.alignment, 0);
  assert.equal(f.items[0].sceneItemEnabled, false);
  assert.equal(f.items[1].sceneItemEnabled, true);
  await switchVerticalSource(f.obs, "BC - Unpaired", async () => {});
  assert.equal(
    f.calls.filter(([type]) => type === "CreateSceneItem").length,
    1,
  );
});
test("rotated fit contains different source aspect ratios inside the portrait canvas", () => {
  const t = rotatedPortraitTransform(720, 1280);
  for (const [w, h] of [
    [1920, 1080],
    [1440, 1080],
    [2560, 1080],
  ]) {
    const scale = Math.min(t.boundsWidth / w, t.boundsHeight / h);
    assert.ok(h * scale <= 720);
    assert.ok(w * scale <= 1280);
  }
});
