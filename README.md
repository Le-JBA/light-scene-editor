# light-scene-editor

A small plug for Home Assistant to modify lights in a scene without using yaml or the fucking live view.

This thing was absolutely 100% vibe coded with Claude. I have not written a single line of code.

If it breaks something, blame the corporate overlords.

## Installation

Make folder /www/light-scene-editor/ in your homeassistant directory. Upload the light-scene-editor.js into the new folder. Edit configuration.yaml in your homeassistant directory:

```

panel_custom:
  - name: light-scene-editor
    sidebar_title: Light scenes
    sidebar_icon: mdi:lightbulb-group-outline
    url_path: light-scenes
    module_url: /local/light-scene-editor/light-scene-editor.js?v=1
    require_admin: true

```

Restart HA, you should now have the editor in your sidebar.
