"""Compact converted GLBs without changing geometry or skin weights.

Usage: python compact-game-operators.py <directory> [operator-id]
"""
from pathlib import Path
import hashlib
import io
import json
import struct
import sys
from PIL import Image

folder = Path(sys.argv[1])
files = [folder / (sys.argv[2] + '.glb')] if len(sys.argv) > 2 else sorted([*folder.glob('88*.glb'), *folder.glob('ai-*.glb')])
for path in files:
    raw = path.read_bytes(); size = struct.unpack_from('<I', raw, 12)[0]
    g = json.loads(raw[20:20+size]); data = bytearray(raw[28+size:])
    widths = {'SCALAR':1, 'VEC2':2, 'VEC3':3, 'VEC4':4, 'MAT4':16}
    def append(blob):
        data.extend(b'\0' * (-len(data) % 4)); index = len(g['bufferViews'])
        g['bufferViews'].append({'buffer':0, 'byteOffset':len(data), 'byteLength':len(blob)})
        data.extend(blob); return index
    for anim in g.get('animations', []):
        for sampler in anim['samplers']:
            acc = g['accessors'][sampler['output']]
            if acc['componentType'] != 5126: continue
            width = widths[acc['type']]; view = g['bufferViews'][acc['bufferView']]
            start = view.get('byteOffset',0)+acc.get('byteOffset',0); stride = view.get('byteStride',width*4)
            first = struct.unpack_from('<'+'f'*width, data, start)
            static_pose = anim['name'] == 'TPose'
            constant = static_pose or all(max(abs(a-b) for a,b in zip(first,struct.unpack_from('<'+'f'*width,data,start+i*stride))) < 1e-6 for i in range(1,acc['count']))
            if constant:
                for role in ['input','output']:
                    old = g['accessors'][sampler[role]]; v = g['bufferViews'][old['bufferView']]
                    start = v.get('byteOffset',0)+old.get('byteOffset',0); length = widths[old['type']]*4
                    if anim['name']=='Death' and role=='output': start+=(old['count']-1)*v.get('byteStride',length)
                    blob = struct.pack('<f',0) if role=='input' else data[start:start+length]
                    new = {**old, 'count':1, 'bufferView':append(blob), 'byteOffset':0}
                    if role == 'input': new['min'] = new['max'] = [0]
                    else: new.pop('min',None); new.pop('max',None)
                    sampler[role] = len(g['accessors']); g['accessors'].append(new)
    for anim in g.get('animations', []):
        channels=[]; samplers=[]
        for channel in anim['channels']:
            sampler=anim['samplers'][channel['sampler']]
            acc=g['accessors'][sampler['output']];kind=channel['target']['path'];node=g['nodes'][channel['target']['node']]
            if acc['count']==1:
                v=g['bufferViews'][acc['bufferView']];start=v.get('byteOffset',0)+acc.get('byteOffset',0)
                value=struct.unpack_from('<'+'f'*widths[acc['type']],data,start)
                reference=node.get(kind,{'rotation':[0,0,0,1],'translation':[0,0,0],'scale':[1,1,1]}[kind])
                equal=max(abs(a-b) for a,b in zip(value,reference))<1e-5
                if equal and (anim['name']!='TPose' or channels):continue
            channel['sampler']=len(samplers);channels.append(channel);samplers.append(sampler)
        anim['channels']=channels;anim['samplers']=samplers
    opaque_colors = set()
    for m in g.get('materials', []):
        tex = m.get('pbrMetallicRoughness',{}).get('baseColorTexture')
        if tex and m.get('alphaMode','OPAQUE') == 'OPAQUE': opaque_colors.add(g['textures'][tex['index']]['source'])
    for i,im in enumerate(g.get('images', [])):
        v = g['bufferViews'][im['bufferView']]; start = v.get('byteOffset',0)
        picture = Image.open(io.BytesIO(data[start:start+v['byteLength']]))
        buf = io.BytesIO()
        if i in opaque_colors:
            picture.convert('RGB').save(buf,format='JPEG',quality=88,subsampling=0); im['mimeType']='image/jpeg'
        else: picture.save(buf,format='PNG',optimize=True)
        im['bufferView'] = append(buf.getvalue())
    used = set()
    for mesh in g['meshes']:
        for p in mesh['primitives']:
            used.add(p['indices']); used.update(p['attributes'].values())
    for skin in g.get('skins',[]): used.add(skin['inverseBindMatrices'])
    for anim in g.get('animations',[]):
        for s in anim['samplers']: used.update([s['input'],s['output']])
    remap={old:new for new,old in enumerate(sorted(used))}
    for mesh in g['meshes']:
        for p in mesh['primitives']:
            p['indices']=remap[p['indices']]; p['attributes']={k:remap[v] for k,v in p['attributes'].items()}
    for skin in g.get('skins',[]): skin['inverseBindMatrices']=remap[skin['inverseBindMatrices']]
    for anim in g.get('animations',[]):
        for s in anim['samplers']: s['input']=remap[s['input']]; s['output']=remap[s['output']]
    g['accessors']=[g['accessors'][i] for i in sorted(used)]
    refs=g['accessors']+g.get('images',[]); views=[]; packed=bytearray(); dedup={}
    for ref in refs:
        v=g['bufferViews'][ref['bufferView']]; start=v.get('byteOffset',0); blob=data[start:start+v['byteLength']]
        signature=(hashlib.sha256(blob).digest(),v.get('byteStride'),v.get('target'))
        if signature not in dedup:
            packed.extend(b'\0'*(-len(packed)%4)); dedup[signature]=len(views)
            views.append({**v,'buffer':0,'byteOffset':len(packed)}); packed.extend(blob)
        ref['bufferView']=dedup[signature]
    g['bufferViews']=views; packed.extend(b'\0'*(-len(packed)%4));g['buffers']=[{'byteLength':len(packed)}]
    # Static poses share most values. Share accessors too, not just their bytes.
    unique=[]; accessors={}; aliases={}
    for old,acc in enumerate(g['accessors']):
        acc.pop('name',None)
        signature=json.dumps(acc,sort_keys=True)
        if signature not in accessors: accessors[signature]=len(unique);unique.append(acc)
        aliases[old]=accessors[signature]
    for mesh in g['meshes']:
        for p in mesh['primitives']:
            p['indices']=aliases[p['indices']];p['attributes']={k:aliases[v] for k,v in p['attributes'].items()}
    for skin in g.get('skins',[]):skin['inverseBindMatrices']=aliases[skin['inverseBindMatrices']]
    for anim in g.get('animations',[]):
        for s in anim['samplers']:s['input']=aliases[s['input']];s['output']=aliases[s['output']]
    g['accessors']=unique
    # Blender nests skinned meshes under an identity armature container. Place
    # those meshes at scene root so all glTF readers agree on skin transforms.
    for scene in g.get('scenes',[]):
        for parent_index in list(scene['nodes']):
            parent=g['nodes'][parent_index]
            if any(key in parent for key in ['matrix','translation','rotation','scale']):continue
            for child in list(parent.get('children',[])):
                if 'skin' in g['nodes'][child]:
                    parent['children'].remove(child);scene['nodes'].append(child)
    header=json.dumps(g,separators=(',',':')).encode(); header+=b' '*(-len(header)%4)
    path.write_bytes(struct.pack('<III',0x46546c67,2,28+len(header)+len(packed))+struct.pack('<II',len(header),0x4e4f534a)+header+struct.pack('<II',len(packed),0x004e4942)+packed)
    print(path.name,len(raw),'->',path.stat().st_size,flush=True)
