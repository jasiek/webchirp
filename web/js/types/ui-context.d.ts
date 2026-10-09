// The ctx object web/js/ui.js builds and hands every UI module factory
// (create<Area>(ctx), see CLAUDE.md's UI module conventions), named member by
// member. Each module reads it through a JSDoc import type:
//
//   /** @typedef {import("../types/ui-context.js").UiContext} UiContext */
//
// It lives in a declaration file, not in web/js/ui.js, so the type that names
// every module's factory sits outside the module graph it describes: no UI
// module has to type-import the composer that imports it. Nothing loads this
// file at runtime, and *.d.ts never reaches dist/.

import type { UiDom } from "../ui/dom.ts";
import type { UiState } from "../ui/state.ts";
import type { createDebugLog } from "../ui/debug-log.ts";
import type { createNoticeModal } from "../ui/notice-modal.ts";
import type { createProgress } from "../ui/progress.ts";
import type { createRadioSession } from "../ui/radio-session.js";
import type { createSettingsPanel } from "../ui/settings-panel.js";
import type { createChannelTable } from "../ui/channel-table.js";
import type { createChannelExtra } from "../ui/channel-extra.js";
import type { createChannelBulkEdit } from "../ui/channel-bulk-edit.js";
import type { createRadioCatalog } from "../ui/radio-catalog.js";
import type { createRepeaterQuery } from "../ui/repeater-query.js";
import type { createRepeaterMap } from "../ui/repeater-map.js";
import type { createCodeplugIo } from "../ui/codeplug-io.js";
import type { createSerialActions } from "../ui/serial-actions.js";
import type { createInstallButton } from "../ui/install-button.js";
import type { createConnectivity } from "../ui/connectivity.js";

// The cross-module registry web/js/ui.js builds: calls that would otherwise
// make a module import a sibling that imports it back.
export interface UiActions {
  updateSerialActionState(): void;
  setEditorView(view: string): void;
  // Whether any modal that owns the keyboard is open.
  isAnyModalOpen(): boolean;
  openChannelExtra(rowIdx: number, trigger?: HTMLElement | null): unknown;
  // The grid's row selection moved.
  channelSelectionChanged(): void;
  // "channels" or "radio settings", for status lines.
  currentViewLabel(): string;
}

export interface UiContext {
  dom: UiDom;
  state: UiState;
  log: ReturnType<typeof createDebugLog>;
  progress: ReturnType<typeof createProgress>;
  notice: ReturnType<typeof createNoticeModal>;
  actions: UiActions;
  // Constructed after the members above and attached with Object.assign, so
  // reachable only after every factory has returned.
  session: ReturnType<typeof createRadioSession>;
  settings: ReturnType<typeof createSettingsPanel>;
  table: ReturnType<typeof createChannelTable>;
  channelExtra: ReturnType<typeof createChannelExtra>;
  bulkEdit: ReturnType<typeof createChannelBulkEdit>;
  catalog: ReturnType<typeof createRadioCatalog>;
  repeaterQuery: ReturnType<typeof createRepeaterQuery>;
  repeaterMap: ReturnType<typeof createRepeaterMap>;
  codeplugIo: ReturnType<typeof createCodeplugIo>;
  serial: ReturnType<typeof createSerialActions>;
  installButton: ReturnType<typeof createInstallButton>;
  connectivity: ReturnType<typeof createConnectivity>;
}
