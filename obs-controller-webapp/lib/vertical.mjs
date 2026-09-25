import { isVertical, request, vendorCall } from "./scenes.mjs";

export const OUTPUT_SCENE = "Vertical Output";

export function rotatedPortraitTransform(width, height) {
  return {
    positionX: width / 2,
    positionY: height / 2,
    alignment: 0,
    rotation: 90,
    scaleX: 1,
    scaleY: 1,
    boundsType: "OBS_BOUNDS_SCALE_INNER",
    boundsWidth: height,
    boundsHeight: width,
    boundsAlignment: 0,
    cropTop: 0,
    cropBottom: 0,
    cropLeft: 0,
    cropRight: 0,
    cropToBounds: false,
  };
}

export async function verticalState(obs, mainScenes) {
  const main = mainScenes ?? (await request(obs, "GetSceneList")).scenes;
  const canvases = (await request(obs, "GetCanvasList")).canvases;
  const candidates = canvases.filter(
    (c) => !c.canvasFlags.MAIN && c.canvasName === "Restream Vertical",
  );
  if (candidates.length !== 1)
    throw new Error("Expected one Restream Vertical canvas.");
  const canvas = candidates[0];
  const scenes = (
    await request(obs, "GetSceneList", { canvasUuid: canvas.canvasUuid })
  ).scenes;
  const target = scenes.find((s) => s.sceneName === OUTPUT_SCENE);
  const dock = await vendorCall(obs, "get_scenes");
  if (!target || !dock.scenes.some((s) => s.name === OUTPUT_SCENE)) {
    throw new Error(
      "Create a scene named Vertical Output in the Restream Vertical dock.",
    );
  }
  const sources = main.filter(
    (s) => isVertical(s.sceneName) || /^BC/i.test(s.sceneName),
  );
  const sourceIds = new Set(sources.map((s) => s.sceneUuid));
  const items = (
    await request(obs, "GetSceneItemList", { sceneUuid: target.sceneUuid })
  ).sceneItems;
  const managed = items.filter((i) => sourceIds.has(i.sourceUuid));
  const visible = managed.filter((i) => i.sceneItemEnabled);
  const current = (await vendorCall(obs, "current_scene")).scene;
  return {
    canvas,
    target,
    sources,
    managed,
    current,
    active:
      current === OUTPUT_SCENE && visible.length === 1
        ? visible[0].sourceName
        : "",
    warning:
      visible.length > 1
        ? "Multiple vertical sources are visible. Select a scene to show only that source."
        : "",
  };
}

export async function switchVerticalSource(
  obs,
  name,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  const state = await verticalState(obs);
  const source = state.sources.find((s) => s.sceneName === name);
  if (!source)
    throw new Error(
      "This broadcast scene no longer exists in the main canvas.",
    );
  const sceneUuid = state.target.sceneUuid;
  let item = state.managed.find((i) => i.sourceUuid === source.sceneUuid);
  const fallback = !isVertical(name);
  if (!item) {
    const created = await request(obs, "CreateSceneItem", {
      sceneUuid,
      sourceUuid: source.sceneUuid,
      sceneItemEnabled: false,
    });
    item = { ...created, sceneItemEnabled: false };
    // Match an existing nested scene's framing. With an empty wrapper, fit the whole source.
    const portraitItems = state.managed.filter((i) => isVertical(i.sourceName));
    const template =
      portraitItems.find((i) => i.sceneItemEnabled) ?? portraitItems[0];
    const keys = [
      "positionX",
      "positionY",
      "rotation",
      "scaleX",
      "scaleY",
      "alignment",
      "boundsType",
      "boundsAlignment",
      "boundsWidth",
      "boundsHeight",
      "cropTop",
      "cropBottom",
      "cropLeft",
      "cropRight",
      "cropToBounds",
    ];
    const transform = fallback
      ? rotatedPortraitTransform(
          state.canvas.canvasVideoSettings.baseWidth,
          state.canvas.canvasVideoSettings.baseHeight,
        )
      : template
        ? Object.fromEntries(
            keys
              .filter((k) => k in template.sceneItemTransform)
              .map((k) => [k, template.sceneItemTransform[k]]),
          )
        : {
            positionX: 0,
            positionY: 0,
            alignment: 5,
            boundsType: "OBS_BOUNDS_SCALE_INNER",
            boundsWidth: state.canvas.canvasVideoSettings.baseWidth,
            boundsHeight: state.canvas.canvasVideoSettings.baseHeight,
            boundsAlignment: 0,
          };
    try {
      await request(obs, "SetSceneItemTransform", {
        sceneUuid,
        sceneItemId: item.sceneItemId,
        sceneItemTransform: transform,
      });
    } catch (error) {
      await request(obs, "RemoveSceneItem", {
        sceneUuid,
        sceneItemId: item.sceneItemId,
      }).catch(() => {});
      throw error;
    }
  } else if (fallback) {
    // Recompute for current canvas dimensions and clear any stale crop or manual rotation.
    await request(obs, "SetSceneItemTransform", {
      sceneUuid,
      sceneItemId: item.sceneItemId,
      sceneItemTransform: rotatedPortraitTransform(
        state.canvas.canvasVideoSettings.baseWidth,
        state.canvas.canvasVideoSettings.baseHeight,
      ),
    });
  }
  const affected = [...state.managed];
  if (!affected.some((i) => i.sceneItemId === item.sceneItemId))
    affected.push(item);
  try {
    await request(obs, "SetSceneItemEnabled", {
      sceneUuid,
      sceneItemId: item.sceneItemId,
      sceneItemEnabled: true,
    });
    for (const other of state.managed) {
      if (other.sceneItemId !== item.sceneItemId && other.sceneItemEnabled) {
        await request(obs, "SetSceneItemEnabled", {
          sceneUuid,
          sceneItemId: other.sceneItemId,
          sceneItemEnabled: false,
        });
      }
    }
    if (state.current !== OUTPUT_SCENE)
      await vendorCall(obs, "switch_scene", { scene: OUTPUT_SCENE });
    for (let i = 0; i < 12; i++) {
      await wait(250);
      if ((await verticalState(obs)).active === name) return;
    }
    throw new Error(
      "OBS did not confirm the selected source in Vertical Output.",
    );
  } catch (error) {
    const rollback = await Promise.allSettled(
      affected.map((i) =>
        request(obs, "SetSceneItemEnabled", {
          sceneUuid,
          sceneItemId: i.sceneItemId,
          sceneItemEnabled: i.sceneItemEnabled,
        }),
      ),
    );
    if (rollback.some((r) => r.status === "rejected"))
      throw new Error(
        "Switch failed and source visibility could not be fully restored. Check Vertical Output in OBS.",
      );
    throw error;
  }
}
