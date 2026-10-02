// src/services/live2d/beforeUpdate.ts
var handlers = [];
var installed = false;
var registerBeforeUpdate = (fn) => {
  if (typeof fn !== "function" || handlers.includes(fn)) return;
  handlers.push(fn);
  installBeforeUpdate();
};
var runBeforeUpdate = () => {
  for (const fn of handlers) {
    try {
      fn();
    } catch {
    }
  }
};
var installBeforeUpdate = (host) => {
  if (installed) return;
  const h = host ?? (typeof window !== "undefined" ? window : null);
  if (!h) return;
  try {
    Object.defineProperty(h, "__noriBeforeModelUpdate", {
      value: runBeforeUpdate,
      writable: false,
      enumerable: false,
      configurable: true
    });
  } catch {
    ;
    h.__noriBeforeModelUpdate = runBeforeUpdate;
  }
  ;
  h.__noriRegisterBeforeUpdate = registerBeforeUpdate;
  h.__noriBeforeUpdateCount = beforeUpdateHandlerCount;
  installed = true;
};
var beforeUpdateHandlerCount = () => handlers.length;
var __resetBeforeUpdateForTest = () => {
  handlers.length = 0;
  installed = false;
};
export {
  __resetBeforeUpdateForTest,
  beforeUpdateHandlerCount,
  installBeforeUpdate,
  registerBeforeUpdate,
  runBeforeUpdate
};
