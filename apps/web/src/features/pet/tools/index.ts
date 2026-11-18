// ペットが使えるツールの一覧（PetTools が所有する）。会話の進行役・音声会話はここだけを参照する。

import type { PetTool } from "../contract";
import { getPageContextTool } from "./page-context";

export function getPetTools(): PetTool[] {
  return [getPageContextTool];
}
