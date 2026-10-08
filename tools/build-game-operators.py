"""Bake mobile operator GLBs. Blender 4.5, --background --disable-autoexec.
Arguments after --: prepared-directory output-directory [operator-id].
No textures are retained; six vertex colors, one rig and two geometry levels.
"""
import bpy
import numpy as np
import sys
from pathlib import Path

args=sys.argv[sys.argv.index('--')+1:]
desktop='--desktop' in args
args=[value for value in args if value!='--desktop']
triangle_budget=24000 if desktop else 3500
source,output=map(Path,args[:2])
folders=[source/args[2]] if len(args)>2 else sorted(source.iterdir())
for folder in folders:
    if not folder.is_dir(): continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for path in sorted(folder.glob('*.glb'),key=lambda p:'Body_3P' not in p.name):
        bpy.ops.import_scene.gltf(filepath=str(path))
    rigs=[o for o in bpy.context.scene.objects if o.type=='ARMATURE']
    rig=max(rigs,key=lambda o:len(o.data.bones))
    for armature in rigs: armature.data.pose_position='REST'
    bpy.context.view_layer.update()
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH' and any(m.type=='ARMATURE' for m in o.modifiers)]
    for obj in list(bpy.context.scene.objects):
        if obj.type=='MESH' and obj not in meshes:bpy.data.objects.remove(obj,do_unlink=True)
    images={};samples=[];mesh_colors=[]
    for mesh in meshes:
        for mod in mesh.modifiers:
            if mod.type!='ARMATURE': continue
            old=mod.object
            weighted={g.group for vertex in mesh.data.vertices for g in vertex.groups if g.weight>1e-5}
            for group in mesh.vertex_groups:
                if group.index not in weighted:continue
                if group.name not in rig.data.bones: raise ValueError('Missing bone '+group.name)
                # Separate hair rigs may use different rest axes. Rebinding in
                # REST mode preserves the mesh in world space on the body rig.
            mod.object=rig
        world=mesh.matrix_world.copy();mesh.parent=rig;mesh.matrix_world=world
        colors=np.ones((len(mesh.data.loops),4),dtype=np.float32)
        uv=mesh.data.uv_layers.active
        for poly in mesh.data.polygons:
            mat=mesh.material_slots[poly.material_index].material if len(mesh.material_slots)>poly.material_index else None
            if mat is None:
                colors[list(poly.loop_indices),:3]=.04
                continue
            bsdf=next((n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
            socket=bsdf.inputs['Base Color'] if bsdf else None
            node=socket.links[0].from_node if socket and socket.is_linked else None
            def find_image(node, seen=None):
                seen=set() if seen is None else seen
                if node is None or node in seen:return None
                seen.add(node)
                if node.type=='TEX_IMAGE':return node.image
                for input in node.inputs:
                    for link in input.links:
                        found=find_image(link.from_node,seen)
                        if found:return found
                return None
            img=find_image(node)
            if 'hair' in mat.name.lower():
                colors[list(poly.loop_indices),:3]=[.025,.022,.018]
                continue
            if img and uv:
                if img.name not in images:
                    px=np.empty(len(img.pixels),dtype=np.float32);img.pixels.foreach_get(px);images[img.name]=px.reshape(img.size[1],img.size[0],4)
                px=images[img.name]
                for index in poly.loop_indices:
                    u,v=uv.data[index].uv
                    colors[index,:3]=px[int(v*px.shape[0])%px.shape[0],int(u*px.shape[1])%px.shape[1],:3]
            else:
                color=list(socket.default_value) if socket else [.08,.08,.08,1]
                colors[list(poly.loop_indices),:3]=color[:3]
        mesh_colors.append((mesh,colors));samples.append(colors[::max(1,len(colors)//2048),:3])
    sample=np.concatenate(samples)
    # A small per-character palette keeps the recognizable clothing blocks.
    palette=sample[np.linspace(0,len(sample)-1,6,dtype=int)].copy()
    for _ in range(12):
        labels=((sample[:,None,:]-palette[None,:,:])**2).sum(2).argmin(1)
        for k in range(6):
            if np.any(labels==k):palette[k]=sample[labels==k].mean(0)
    for mesh,colors in mesh_colors:
        labels=((colors[:,:3,None]-palette.T[None,:,:])**2).sum(1).argmin(1)
        colors[:,:3]=palette[labels]
        while mesh.data.color_attributes:mesh.data.color_attributes.remove(mesh.data.color_attributes[0])
        attr=mesh.data.color_attributes.new(name='Color',type='BYTE_COLOR',domain='CORNER')
        attr.data.foreach_set('color',colors.ravel())
    for other in rigs:
        if other!=rig:bpy.data.objects.remove(other,do_unlink=True)
    material=bpy.data.materials.new('Operator colors');material.use_nodes=True
    bsdf=material.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Roughness'].default_value=1;bsdf.inputs['Metallic'].default_value=0
    color_node=material.node_tree.nodes.new('ShaderNodeVertexColor');color_node.layer_name='Color'
    material.node_tree.links.new(color_node.outputs['Color'],bsdf.inputs['Base Color'])
    for mesh in meshes:
        mesh.data.materials.clear();mesh.data.materials.append(material)
        for polygon in mesh.data.polygons:polygon.material_index=0
    bpy.ops.object.select_all(action='DESELECT')
    for mesh in meshes:mesh.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0];bpy.ops.object.join();high=bpy.context.object;high.name='Operator_LOD0'
    bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.mesh.remove_doubles(threshold=.00001);bpy.ops.object.mode_set(mode='OBJECT')
    count=sum(len(p.vertices)-2 for p in high.data.polygons)
    if count>triangle_budget:
        mod=high.modifiers.new('Geometry budget','DECIMATE');mod.ratio=triangle_budget/count;mod.use_collapse_triangulate=True
        high.modifiers.move(len(high.modifiers)-1,0);bpy.ops.object.modifier_apply(modifier=mod.name)
    low=high.copy();low.data=high.data.copy();low.name='Operator_LOD1';bpy.context.collection.objects.link(low)
    bpy.ops.object.select_all(action='DESELECT');low.select_set(True);bpy.context.view_layer.objects.active=low
    mod=low.modifiers.new('Distance mesh','DECIMATE');mod.ratio=.18 if desktop else .22;mod.use_collapse_triangulate=True;low.modifiers.move(len(low.modifiers)-1,0);bpy.ops.object.modifier_apply(modifier=mod.name)
    for mesh in [high,low]:
        # Re-quantize colors interpolated by decimation.
        attr=mesh.data.color_attributes['Color'];values=np.empty(len(attr.data)*4,dtype=np.float32);attr.data.foreach_get('color',values);values=values.reshape(-1,4)
        labels=((values[:,:3,None]-palette.T[None,:,:])**2).sum(1).argmin(1);values[:,:3]=palette[labels];values[:,3]=1;attr.data.foreach_set('color',values.ravel())
        mesh.data.validate(clean_customdata=False)
        while mesh.data.uv_layers:mesh.data.uv_layers.remove(mesh.data.uv_layers[0])
    if rig.animation_data:
        rig.animation_data.action=None
        for track in list(rig.animation_data.nla_tracks):
            if track.name not in ['TPose','Idle','Walk','Run','Left','Right','Backward','Sprint','Crouch','Downed','Prone','Swim','SwimIdle','Fall','Death','Relaxed']:
                rig.animation_data.nla_tracks.remove(track)
    rig.data.pose_position='POSE'
    for obj in bpy.context.scene.objects:obj.select_set(obj in [high,low,rig])
    bpy.context.view_layer.objects.active=rig;bpy.context.scene.frame_set(0)
    output.mkdir(parents=True,exist_ok=True);target=output/(folder.name+('.desktop.glb' if desktop else '.glb'))
    bpy.ops.export_scene.gltf(filepath=str(target),export_format='GLB',use_selection=True,export_animations=True,
        export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_frame_step=1 if desktop else 2,
        export_skins=True,export_morph=False,export_texcoords=False,export_normals=True,export_extras=False)
    print('PACKED_OPERATOR',folder.name,'desktop' if desktop else 'phone',target.stat().st_size,flush=True)
