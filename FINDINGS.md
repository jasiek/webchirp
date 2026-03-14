## 2026-03-14

- Some CHIRP drivers do not instantiate cleanly with `None` when enumerating metadata or settings from a non-downloaded state. Generic runtime helpers should fall back to `radio_cls("")` to preserve best-effort schema loading before a live download.
- Clone-mode settings introspection is not safe to assume on blank/default state. `get_radio_settings()` can fail for drivers like `baofeng_uv17Pro.UV17Pro` unless the runtime has first been seeded with a real cached image or download result.
