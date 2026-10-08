"""Prepare CUE4Parse game exports for the offline mobile bake.
Usage: python tools/prepare-game-operators.py <export-work-directory> [operator-id]
The directory contains exported/, operators.json and motion-map.json.
"""
from pathlib import Path
import io, json, struct, sys
from PIL import Image, ImageOps

BASE = Path(sys.argv[1]).resolve()
EXPORTED = BASE / 'exported'
OUT = BASE / 'prepared'
OUT.mkdir(exist_ok=True)
materials = {}
for p in EXPORTED.rglob('*.json'):
    if p.parent != EXPORTED and not p.name.endswith('.motion.json'):
        d = json.loads(p.read_text(encoding='utf-8'))
        if isinstance(d, dict) and 'Textures' in d:
            materials[p.stem] = d
motions = json.loads((BASE / 'motion-map.json').read_text())

def prepare(source, target, animate):
    raw = source.read_bytes()
    size = struct.unpack_from('<I', raw, 12)[0]
    g = json.loads(raw[20:20+size])
    data = bytearray(raw[28+size:])
    def view(blob):
        data.extend(b'\0' * (-len(data) % 4))
        index = len(g.setdefault('bufferViews', []))
        g['bufferViews'].append({'buffer': 0, 'byteOffset': len(data), 'byteLength': len(blob)})
        data.extend(blob)
        return index
    def texture(image):
        buf = io.BytesIO(); image.save(buf, format='PNG', optimize=True)
        index = len(g.setdefault('images', []))
        g['images'].append({'bufferView': view(buf.getvalue()), 'mimeType': 'image/png'})
        ti = len(g.setdefault('textures', [])); g['textures'].append({'source': index})
        return {'index': ti}
    def picture(textures, names, limit):
        ref = next((textures.get(n) for n in names if textures.get(n)), None)
        if not ref: return None
        p = EXPORTED / (ref['ObjectPath'].rsplit('.', 1)[0] + '.png')
        if not p.exists(): raise ValueError(f'Missing texture: {p}')
        im = Image.open(p).convert('RGBA'); im.thumbnail((limit, limit), Image.Resampling.LANCZOS)
        return im
    for m in g.get('materials', []):
        d = materials.get(m['name'], {}); ts = d.get('Textures', {})
        pbr = m['pbrMetallicRoughness'] = {'metallicFactor': 0, 'roughnessFactor': .8}
        diffuse = picture(ts, ['BaseColorMap', 'PM_Diffuse'], 1024)
        if diffuse is not None: pbr['baseColorTexture'] = texture(diffuse)
        else:
            color = d.get('Colors', {}).get('BaseColor', {})
            pbr['baseColorFactor'] = [color.get(c, .04) for c in ['R', 'G', 'B']] + [1]
        hair = picture(ts, ['IDRAMap'], 1024)
        if hair is not None:
            mask = Image.new('RGBA', hair.size, (255, 255, 255, 255)); mask.putalpha(hair.getchannel('A'))
            pbr['baseColorTexture'] = texture(mask); m.update(alphaMode='MASK', alphaCutoff=.33, doubleSided=True)
        elif d.get('BlendMode') == 1:
            m.update(alphaMode='MASK', alphaCutoff=.33, doubleSided=True)
        elif d.get('IsTranslucent'):
            m.update(alphaMode='BLEND', doubleSided=True)
        normal = picture(ts, ['NormalMap', 'PM_Normals'], 512)
        if normal is not None:
            r, green, blue, a = normal.split()
            m['normalTexture'] = texture(Image.merge('RGB', [r, ImageOps.invert(green), blue]))
        mra = picture(ts, ['MRAMap'], 512)
        if mra is not None:
            metal, rough, ao, _ = mra.split()
            tex = texture(Image.merge('RGB', [ao, rough, metal]))
            pbr.update(metallicRoughnessTexture=tex, metallicFactor=1, roughnessFactor=1)
            m['occlusionTexture'] = tex
    # Eye occlusion shells depend on Unreal's custom depth shader; retain the
    # underlying face and eyes instead of exporting those shells as dark solids.
    for mesh in g.get('meshes', []):
        mesh['primitives'] = [p for p in mesh['primitives'] if not any(x in g['materials'][p.get('material',0)].get('name','').lower() for x in ['eyeshadow','eyeocclusion'])]
    if animate:
        def accessor(values, width):
            flat = [v for row in values for v in row] if width > 1 else values
            idx = len(g['accessors'])
            item = {'bufferView':view(struct.pack('<'+'f'*len(flat), *flat)), 'componentType':5126, 'count':len(values), 'type':{1:'SCALAR',3:'VEC3',4:'VEC4'}[width]}
            if width == 1: item.update(min=[min(values)], max=[max(values)])
            g['accessors'].append(item); return idx
        def channel(anim, node, kind, values, times, width):
            idx = len(anim['samplers']); anim['samplers'].append({'input':times,'output':accessor(values,width),'interpolation':'LINEAR'})
            anim['channels'].append({'sampler':idx,'target':{'node':node,'path':kind}})
        nodes = {n.get('name'):i for i,n in enumerate(g['nodes'])}
        pose = {'name':'TPose','samplers':[],'channels':[]}; time = accessor([0],1)
        for i,n in enumerate(g['nodes']):
            if n.get('name') in nodes and 'mesh' not in n:
                channel(pose,i,'rotation',[n.get('rotation',[0,0,0,1])],time,4)
                channel(pose,i,'translation',[n.get('translation',[0,0,0])],time,3)
        g['animations']=[pose]
        for label,filename in motions.items():
            motion=json.loads((EXPORTED/(filename+'.motion.json')).read_text())
            if motion['IsAdditive']: raise ValueError('Additive clip needs base pose: '+filename)
            anim={'name':label,'samplers':[],'channels':[]}
            times=accessor([i/motion['FramesPerSecond'] for i in range(motion['NumFrames'])],1)
            for t in motion['tracks']:
                if t['name'] not in nodes: continue
                node=nodes[t['name']]
                channel(anim,node,'rotation',t['rotations'],times,4)
                if t['name'] in ['Root','Hips']: channel(anim,node,'translation',t['positions'],times,3)
            g['animations'].append(anim)
    data.extend(b'\0' * (-len(data) % 4));g['buffers']=[{'byteLength':len(data)}]
    header=json.dumps(g,separators=(',',':')).encode();header+=b' '*(-len(header)%4)
    target.write_bytes(struct.pack('<III',0x46546c67,2,28+len(header)+len(data))+struct.pack('<II',len(header),0x4e4f534a)+header+struct.pack('<II',len(data),0x004e4942)+data)

jobs=json.loads((BASE/'operators.json').read_text(encoding='utf-8'))
if len(sys.argv)>2: jobs=[j for j in jobs if j['id']==sys.argv[2]]
for job in jobs:
    parts=sorted(job['paths'], key=lambda p:'Body_3P' not in p)
    folder=OUT/job['id'];folder.mkdir(exist_ok=True)
    for part in parts:
        source=EXPORTED/Path(part).with_suffix('.glb')
        prepare(source,folder/source.name,part == parts[0])
    print(job['id'], 'prepared', len(parts), flush=True)
