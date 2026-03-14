## 2026-03-14

- Some CHIRP drivers do not instantiate cleanly with `None` when enumerating metadata or settings from a non-downloaded state. Generic runtime helpers should fall back to `radio_cls("")` to preserve best-effort schema loading before a live download.
