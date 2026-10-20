/** Floating-window regression entry; first start app/android/.harness/server.mjs.
 * Real mesh/alpha bounds, DPR/renderScale, resize, reaction protection, pause and
 * remount coverage lives in e2e-float-crop.mjs. It replaces obsolete contain assertions.
 * Run: node tmp-memcheck/e2e-float.mjs [ARGNori|Nori]
 * Browser tests with a fake bridge do not replace Android / One UI device testing.
 */
await import('./e2e-float-crop.mjs')
