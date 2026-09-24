import assert from "node:assert/strict";
import test from "node:test";
import { broadcastPairs, switchPair } from "../lib/paired.mjs";

test("only BC-prefixed main scenes are buttons and counterparts match by full name", () => {
  assert.deepEqual(
    broadcastPairs([
      "Audio",
      "Car BC",
      "BC - Car",
      "BC - Car (Vertical)",
      "BC - Car Alt",
      "BC - Car Alt (Vertical)",
      "BC - Missing",
    ]),
    [
      { horizontal: "BC - Car", vertical: "BC - Car (Vertical)" },
      { horizontal: "BC - Car Alt", vertical: "BC - Car Alt (Vertical)" },
      { horizontal: "BC - Missing", vertical: "BC - Missing" },
    ],
  );
});
test("ambiguous portrait counterparts are not selected arbitrarily", () => {
  assert.equal(
    broadcastPairs([
      "BC - Car",
      "BC - Car (Vertical)",
      "BC - Car (vertical)",
    ])[0].vertical,
    null,
  );
});
test("a missing BC scene fails without changing either output", async () => {
  const calls = [];
  await assert.rejects(
    switchPair(
      {
        call: async (type) => {
          calls.push(type);
          return { scenes: [{ sceneName: "BC - Car" }] };
        },
      },
      "BC - Missing",
    ),
    /Neither output was changed/,
  );
  assert.deepEqual(calls, ["GetSceneList"]);
});

function fake(failHorizontal = false, fallback = false) {
  let enabled = false,
    main = "BC - Old";
  const calls = [];
  return {
    calls,
    obs: {
      call: async (type, data) => {
        calls.push([type, data]);
        if (type === "GetSceneList")
          return {
            scenes: data?.canvasUuid
              ? [{ sceneName: "Vertical Output", sceneUuid: "wrapper" }]
              : [
                  { sceneName: "BC - Car", sceneUuid: "car" },
                  ...(fallback
                    ? []
                    : [
                        {
                          sceneName: "BC - Car (Vertical)",
                          sceneUuid: "portrait",
                        },
                      ]),
                ],
          };
        if (type === "GetCanvasList")
          return {
            canvases: [
              {
                canvasName: "Restream Vertical",
                canvasUuid: "canvas",
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
          return {
            sceneItems: [
              {
                sourceUuid: fallback ? "car" : "portrait",
                sourceName: fallback ? "BC - Car" : "BC - Car (Vertical)",
                sceneItemId: 1,
                sceneItemEnabled: enabled,
              },
            ],
          };
        if (type === "SetSceneItemTransform") return {};
        if (type === "SetSceneItemEnabled") {
          enabled = data.sceneItemEnabled;
          return {};
        }
        if (type === "SetCurrentProgramScene") {
          if (failHorizontal) throw Error("Main switch failed");
          main = data.sceneName;
          return {};
        }
        if (type === "GetCurrentProgramScene")
          return { currentProgramSceneName: main };
        throw Error(`Unexpected ${type}`);
      },
    },
  };
}
test("one action switches and confirms both views", async () => {
  const f = fake();
  assert.deepEqual(await switchPair(f.obs, "BC - Car", async () => {}), {
    horizontal: "BC - Car",
    vertical: "BC - Car (Vertical)",
  });
  assert.ok(
    f.calls.some(([t, d]) => t === "SetSceneItemEnabled" && d.sceneItemEnabled),
  );
  assert.ok(
    f.calls.some(
      ([t, d]) => t === "SetCurrentProgramScene" && d.sceneName === "BC - Car",
    ),
  );
});
test("partial failure is explicit rather than reporting success for both outputs", async () => {
  const f = fake(true);
  await assert.rejects(
    switchPair(f.obs, "BC - Car", async () => {}),
    /paired switch was not fully confirmed/,
  );
});
test("unpaired BC scene switches both outputs using a rotated horizontal fallback", async () => {
  const f = fake(false, true);
  assert.deepEqual(await switchPair(f.obs, "BC - Car", async () => {}), {
    horizontal: "BC - Car",
    vertical: "BC - Car",
  });
  assert.equal(
    f.calls.find(([t]) => t === "SetSceneItemTransform")[1].sceneItemTransform
      .rotation,
    90,
  );
  assert.ok(
    f.calls.some(
      ([t, d]) => t === "SetCurrentProgramScene" && d.sceneName === "BC - Car",
    ),
  );
});
