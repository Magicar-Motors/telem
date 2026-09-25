import { isVertical, request, switchScene } from "./scenes.mjs";
import { switchVerticalSource, verticalState } from "./vertical.mjs";

export const isBroadcastScene = (name) => /^BC/i.test(name);
export const horizontalName = (name) =>
  name.replace(/\s*\(vertical\)\s*$/i, "").trim();

/** @param {string[]} names */
export function broadcastPairs(names) {
  const eligible = names.filter(isBroadcastScene);
  return eligible
    .filter((n) => !isVertical(n))
    .map((horizontal) => {
      const matches = eligible.filter(
        (n) => isVertical(n) && horizontalName(n) === horizontal,
      );
      return {
        horizontal,
        vertical:
          matches.length === 1
            ? matches[0]
            : matches.length === 0
              ? horizontal
              : null,
      };
    });
}

export async function switchPair(
  obs,
  name,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  const main = await request(obs, "GetSceneList");
  const pair = broadcastPairs(main.scenes.map((s) => s.sceneName)).find(
    (p) => p.horizontal === name,
  );
  if (!pair?.vertical)
    throw new Error(
      "The BC scene is missing or has ambiguous (Vertical) counterparts. Neither output was changed.",
    );
  await switchVerticalSource(obs, pair.vertical, wait);
  try {
    await switchScene(obs, "horizontal", pair.horizontal, wait);
    const [horizontal, vertical] = await Promise.all([
      request(obs, "GetCurrentProgramScene"),
      verticalState(obs),
    ]);
    if (
      horizontal.currentProgramSceneName !== pair.horizontal ||
      vertical.active !== pair.vertical
    ) {
      throw new Error("Outputs no longer match the requested pair.");
    }
  } catch (error) {
    throw new Error(
      `The paired switch was not fully confirmed. Vertical was switched to ${pair.vertical}; check both output indicators before retrying. ${error.message}`,
    );
  }
  return pair;
}
