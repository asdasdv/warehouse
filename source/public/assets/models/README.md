# 3D models

Exported 2026-10-30 from `~/Documents/Codex/2026-10-19/blender-mcp/outputs/warehouse-dispatch-conveyor.blend`
(Blender 5.2.2, scene «01 • Warehouse rack»; the conveyor is the «03 • Dispatch conveyor» collection inside it).
The .blend itself was not modified — export ran headless on a copy.

Export settings: glTF binary, **Y-up**, units = metres, modifiers applied (Bevel, Weighted Normal),
materials included (Principled BSDF), **no Draco**, no cameras/lights/animation.

Every model's origin is on the floor (`y = 0` is the floor contact), so it can be placed directly on the ground plane.
Sizes below are bounding boxes in three.js axes: X = width, Y = height, Z = depth.

| File | Source in .blend | Size X × Y × Z, m | Triangles | Origin |
|---|---|---|---|---|
| `rack.glb` | 240 root meshes of the rack: `Upright \| 0…4`, `Bolted foot plate`, `Upright punched slot`, `Frame cross member`, `End diagonal brace`, `Shelf deck 01…07`, `Load beam`, `Shelf ID tab`, `Top rail` | 5.968 × 6.040 × 1.344 | 25 920 | bottom-centre of the rack (Blender world 0,0,0) |
| `pallet.glb` | `Главный поддон` (mesh `PALLET_MASTER • 1200x1000 construction`) | 1.320 × 0.160 × 1.100 | 3 024 | bottom-centre |
| `box.glb` | `Главная коробка` (mesh `CARTON_MASTER • complete box`) | 0.628 × 0.514 × 1.026 | 196 | bottom-centre |
| `robot.glb` | empty `Робот • без груза` + its 16 `Airis \| …` parts (AMR robot, no load) | 1.203 × 0.665 × 1.403 | 8 800 | X/Z = the robot empty (centre), Y = wheel contact |
| `conveyor.glb` | empty `Отгрузка • роликовый конвейер` + 167 children (59 rollers, frame, legs, guide rails, scanner portal, control housing, dispatch tunnel: `Dispatch rear wall` / `Dispatch side wall` / `Dispatch roof`) | 6.638 × 1.940 × 1.912 | 12 592 | X/Z = the conveyor empty (robot hand-off end), Y = foot contact. The model extends from x ≈ −0.04 to +6.60 along +X |
| `rack-layout.json` | transforms of the 56 `Bin a-b-c-d` and 28 `Pallet \| Shelf deck NN.MM` objects | — | — | positions relative to the `rack.glb` origin |

## Notes

- **Bins = boxes.** All 56 `Bin x-x-x-x` objects share the box mesh (`CARTON_MASTER`), and all 28 shelf pallets share the pallet
  mesh, so there is no separate `bin.glb`: instance `box.glb` / `pallet.glb` at the positions in `rack-layout.json`
  (`position` = the item's bottom-centre, which is where the `box.glb` / `pallet.glb` origin is; `quaternion` = [x, y, z, w]).
  All of them have identity rotation.
- **Conveyor marker nodes.** `conveyor.glb` keeps three empty nodes useful as path waypoints (local, metres, Y-up):
  `01 • Robot handoff` (0, 0.65, 0), `02 • Transport` (2.9, 0.65, 0), `03 • Dispatch hide` (5.8, 0.65, 0).
  The demo box that sat on the conveyor (`Демонстрация • коробка на конвейере`) is left out — use `box.glb`.
  The rollers are named `Roller • master`, `Roller • 02 … 59` if you want to spin them.
- **Robot with a load:** the .blend also has `Робот • с коробкой`, which is the same robot with `box.glb` on top
  (box bottom ≈ 0.665 m above the floor, i.e. on the robot's top deck).
- **Materials:** the cardboard and the pallet timber use procedural noise/bump in Blender, which glTF cannot carry,
  so only their base colour/roughness come through. LED/status materials use `KHR_materials_emissive_strength`
  (supported by three.js `GLTFLoader`).
- **Left out:** cameras, lights, `White seamless floor`, `Ground • dotted grid`, and the default `Cube` of the empty `Scene` scene.
