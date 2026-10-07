"""Write the runtime catalog and precompressed assets from the export selection.

Usage: python tools/catalog-game-operators.py <operators.json>
"""
import gzip
import hashlib
import json
import struct
import sys
from pathlib import Path

root=Path(__file__).resolve().parents[1]
selection=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
catalog={}; report=[]
for op in selection:
    path=root/'ui/models/operator'/(op['id']+'.glb')
    raw=path.read_bytes(); digest=hashlib.sha256(raw).hexdigest(); rev=digest[:12]
    packed=gzip.compress(raw,compresslevel=9,mtime=0);path.with_suffix('.glb.gz').write_bytes(packed)
    count=struct.unpack_from('<I',raw,12)[0];model=json.loads(raw[20:20+count])
    triangles=[sum(model['accessors'][p['indices']]['count']//3 for p in mesh['primitives']) for mesh in model['meshes']]
    assert not model.get('images') and not model.get('textures')
    assert len(model['skins'])==1 and max(triangles)<=3500
    catalog[op['name']]={'id':op['id'],'src':f'/ui/models/operator/{op["id"]}.glb?v={rev}','native':True}
    report.append({'id':op['id'],'name':op['name'],'bytes':len(raw),'gzipBytes':len(packed),
        'triangles':triangles,'sha256':digest,'source':op['paths'],'variant':op.get('variant','TPP default')})
    desktop=root/'ui/models/operator'/(op['id']+'.desktop.glb')
    if desktop.exists():
        desktop_raw=desktop.read_bytes();desktop_hash=hashlib.sha256(desktop_raw).hexdigest()
        desktop_packed=gzip.compress(desktop_raw,compresslevel=9,mtime=0);desktop.with_suffix('.glb.gz').write_bytes(desktop_packed)
        desktop_size=struct.unpack_from('<I',desktop_raw,12)[0];desktop_model=json.loads(desktop_raw[20:20+desktop_size])
        desktop_triangles=[sum(desktop_model['accessors'][p['indices']]['count']//3 for p in mesh['primitives']) for mesh in desktop_model['meshes']]
        assert max(desktop_triangles)<=24000 and not desktop_model.get('images')
        catalog[op['name']]['desktop']={'id':op['id'],'src':f'/ui/models/operator/{op["id"]}.desktop.glb?v={desktop_hash[:12]}','native':True,'isDesktop':True}
        report[-1]['desktop']={'bytes':len(desktop_raw),'gzipBytes':len(desktop_packed),'triangles':desktop_triangles,'sha256':desktop_hash}
(root/'m3d/operator-catalog.js').write_text('// Generated from local game assets; do not hand-edit.\nexport const OPERATOR_MODELS = Object.freeze('+json.dumps(catalog,ensure_ascii=False,indent=2)+');\n',encoding='utf-8')
(root/'ui/models/operator/mobile-manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'operators':len(report),'rawBytes':sum(x['bytes'] for x in report),'transferBytes':sum(x['gzipBytes'] for x in report),'maxTransferBytes':max(x['gzipBytes'] for x in report),'desktopTransferBytes':sum(x.get('desktop',{}).get('gzipBytes',0) for x in report)}))
