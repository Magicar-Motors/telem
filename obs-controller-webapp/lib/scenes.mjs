export const VENDOR = "aitum-vertical-canvas"; // Restream retains this vendor ID.
export const isVertical = (name) => /\(vertical\)/i.test(name);

export async function request(obs, type, data) {
  let timer;
  try {
    return await Promise.race([
      obs.call(type, data),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "OBS request timed out. Check the connection and try again.",
              ),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function sceneGroups(main, vertical) {
  const available = new Set(vertical);
  return {
    horizontal: main.filter((name) => !isVertical(name)),
    vertical: [...new Set([...vertical, ...main.filter(isVertical)])].map(
      (name) => ({ name, available: available.has(name) }),
    ),
  };
}

export async function vendorCall(obs, requestType, requestData = {}) {
  const result = await request(obs, "CallVendorRequest", {
    vendorName: VENDOR,
    requestType,
    requestData,
  });
  const data = result.responseData;
  if (!data || data.success === false)
    throw new Error(
      data?.error || "The vertical plugin could not complete the request.",
    );
  return data;
}

export async function switchScene(
  obs,
  orientation,
  name,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  if (orientation === "horizontal") {
    await request(obs, "SetCurrentProgramScene", { sceneName: name });
  } else {
    const list = await vendorCall(obs, "get_scenes");
    if (!list.scenes.some((scene) => scene.name === name)) {
      throw new Error(
        "This scene is not in the Restream Vertical dock yet. Add it there before switching.",
      );
    }
    await vendorCall(obs, "switch_scene", { scene: name });
  }
  // The vendor acknowledges before its queued UI change and may silently ignore a missing scene.
  for (let attempt = 0; attempt < 12; attempt++) {
    await wait(250);
    const active =
      orientation === "horizontal"
        ? (await request(obs, "GetCurrentProgramScene")).currentProgramSceneName
        : (await vendorCall(obs, "current_scene")).scene;
    if (active === name) return;
  }
  throw new Error(
    "OBS did not confirm the scene change. Check the active scene in OBS and try again.",
  );
}
