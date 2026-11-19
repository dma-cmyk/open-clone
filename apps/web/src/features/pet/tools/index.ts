// ペットが使えるツールの一覧（PetTools が所有する）。会話の進行役・音声会話はここだけを参照する。
//
// 並び順: 読む → 移動 → 書き込み（自分の操作） → 書き込み（管理）。
// ツールの数は `PET_LIMITS.toolsMax`（48）以内に収める（中継はこれを超える要求を 400 にする）。

import type { PetTool } from "../contract";
import { getPageContextTool } from "./page-context";
import { readHelpTool } from "./help";
import { listBoardsTool, listThreadsTool, readThreadTool, searchTool } from "./boards";
import { getMeTool } from "./me";
import {
  checkPluginTool,
  getPluginTool,
  listInstalledPluginsTool,
  listMyPluginsTool,
  listPluginTemplatesTool,
  listPluginsTool,
} from "./plugins-read";
import { openPageTool, openPluginEditorTool } from "./navigate";
import { createPostTool, createThreadTool, deleteMyPostTool, editMyPostTool } from "./posts";
import { addNgTool, removeNgTool } from "./ng";
import { addMyPluginVersionTool, createMyPluginTool, installPluginTool, uninstallPluginTool } from "./plugins-write";
import {
  deletePostStaffTool,
  deleteThreadStaffTool,
  handleReportTool,
  hidePostTool,
  listReportsTool,
  restorePostTool,
  updateBoardSettingsTool,
} from "./staff";

export function getPetTools(): PetTool[] {
  return [
    // 読む
    getPageContextTool,
    readHelpTool,
    listBoardsTool,
    listThreadsTool,
    readThreadTool,
    searchTool,
    getMeTool,
    listPluginsTool,
    getPluginTool,
    listMyPluginsTool,
    listInstalledPluginsTool,
    listPluginTemplatesTool,
    checkPluginTool,
    listReportsTool,
    // 移動
    openPageTool,
    openPluginEditorTool,
    // 書き込み（自分）
    createPostTool,
    createThreadTool,
    editMyPostTool,
    deleteMyPostTool,
    addNgTool,
    removeNgTool,
    installPluginTool,
    uninstallPluginTool,
    createMyPluginTool,
    addMyPluginVersionTool,
    // 書き込み（管理・danger）
    deletePostStaffTool,
    deleteThreadStaffTool,
    hidePostTool,
    restorePostTool,
    handleReportTool,
    updateBoardSettingsTool,
  ];
}