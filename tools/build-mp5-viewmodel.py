"""Assemble a standard MP5 from exported native parts and receiver sockets.

Blender --background --python build-mp5-viewmodel.py -- <exported> <output.glb>
This is a default configuration, not a reconstruction of player attachments.
"""
import bpy
import json
import sys
from pathlib import Path
from mathutils import Vector

source, output = map(Path, sys.argv[sys.argv.index('--') + 1:])
base = 'DeltaForce/Content/Models/Weapons/Parts/'
sockets = json.loads((source / 'Rec_SMG_MP5A4-Std_004_1P_Skeleton.json').read_text())
points = {o['Properties']['SocketName']: o['Properties'].get('RelativeLocation', {})
          for o in sockets if o['Type'] == 'SkeletalMeshSocket'}
parts = [
    ('Rec/SMG/Rec_SMG_MP5A4-Std_004/Rec_SMG_MP5A4-Std_004_1P.glb', None),
    ('Bar/Bar_M-225_mp5_076/Bar_M-225_mp5_076_1P.glb', 'Bar_point'),
    ('Han/Han_MP5-Std_008/Han_MP5_Std_008_1P.glb', 'Han_point'),
    ('ReaS/ReaS_MP5A4-Std_004/ReaS_MP5A4_Std_004_1P.glb', 'Rea_point'),
    ('Sto/Sto_A_MP5A4-Std_008/Sto_A_MP5A4-Std_008_1P.glb', 'StoMP5_point'),
    ('Mag/Mag_9-19-30R_MP5A4-Std_007/Mag_MP5A4_9x19_30R_Std_007_1P.glb', 'Mag_point'),
]
# The magazine attaches to an actual bone rather than a Skeleton socket.
points['Mag_point'] = {'X': 0, 'Y': 10.935, 'Z': 5.913}
bpy.ops.wm.read_factory_settings(use_empty=True)
material = bpy.data.materials.new('MP5 matte finish')
material.diffuse_color = (.12, .14, .16, 1)
meshes = []
for relative, socket in parts:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(source / (base + relative)))
    imported = set(bpy.data.objects) - before
    point = points[socket] if socket else {}
    offset = Vector((point.get('X', 0), -point.get('Y', 0), point.get('Z', 0))) * .01
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in imported:
        if obj.type != 'MESH' or not any(mod.type == 'ARMATURE' for mod in obj.modifiers):
            continue
        mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
        while mesh.uv_layers:
            mesh.uv_layers.remove(mesh.uv_layers[0])
        mesh.materials.clear()
        mesh.materials.append(material)
        for polygon in mesh.polygons:
            polygon.material_index = 0
        baked = bpy.data.objects.new('MP5 part', mesh)
        bpy.context.collection.objects.link(baked)
        baked.matrix_world = obj.matrix_world.copy()
        baked.location += offset
        meshes.append(baked)
    for obj in imported:
        bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.object.select_all(action='DESELECT')
for mesh in meshes:
    mesh.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.join()
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_selection=True,
                          export_animations=False, export_skins=False, export_texcoords=False)
print('MP5_VIEWMODEL', output, output.stat().st_size)
