// The only bridge between the page and the main process: a fixed list of channels.

import { contextBridge, ipcRenderer } from "electron";

const INVOKE = [
  "workspace:get", "workspace:choose-folder", "workspace:layout", "profile:options", "profile:add", "profile:remove",
  "brain:search", "session:resume", "sorting:get", "sorting:toggle", "folders:unused", "folders:adopt", "folders:dismiss", "profile:accounts", "free:get", "free:save", "free:test",
  "brain:unfinished", "note:add", "note:remove", "share:info", "share:export", "share:import", "kit:get", "kit:set", "profile:role",
  "ui:save", "update:check", "update:open",
];
const SEND = ["term:start", "term:input", "term:resize"];
const LISTEN = ["term:data", "term:exit", "term:message", "brain:graph", "net:status", "sorting:status", "free:status"];

contextBridge.exposeInMainWorld("api", {
  invoke: (channel: string, ...args: unknown[]) =>
    INVOKE.includes(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error(`blocked: ${channel}`)),
  send: (channel: string, ...args: unknown[]) => {
    if (SEND.includes(channel)) ipcRenderer.send(channel, ...args);
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    if (LISTEN.includes(channel)) ipcRenderer.on(channel, (_event, ...args) => listener(...args));
  },
});
