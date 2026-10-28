"""Run in the saved warehouse Blender scene; exports evaluated, indexed meshes.
Set LOCUS_ASSET_OUTPUT to override the output path. Scene is never mutated.
"""
import bpy, json, os
from mathutils import Vector
output = os.environ.get('LOCUS_ASSET_OUTPUT', bpy.path.abspath('//warehouse-models.json'))
depsgraph = bpy.context.evaluated_depsgraph_get()
assets = {}
for key, name in [('carton','Главная коробка'),('pallet','Главный поддон'),('robot','Робот • без груза')]:
    root = bpy.data.objects[name]
    objects = [root] if root.type == 'MESH' else [o for o in root.children_recursive if o.type == 'MESH']
    points, triangles = [], []
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = obj.data if key == 'pallet' else evaluated.to_mesh()
        mesh.calc_loop_triangles()
        transform = root.matrix_world.inverted() @ obj.matrix_world
        normal_matrix = transform.to_3x3().inverted().transposed()
        for tri in mesh.loop_triangles:
            material = mesh.materials[tri.material_index]
            bsdf = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            color = list(bsdf.inputs['Base Color'].default_value[:3]) if bsdf else list(material.diffuse_color[:3])
            if key == 'pallet': color = [.52,.285,.105]
            desc = {'name': material.name, 'color': color, 'metalness': bsdf.inputs['Metallic'].default_value if bsdf else 0, 'roughness': bsdf.inputs['Roughness'].default_value if bsdf else .8}
            if bsdf and bsdf.inputs.get('Emission Color'):
                desc['emissive'] = list(bsdf.inputs['Emission Color'].default_value[:3])
                desc['emissiveIntensity'] = bsdf.inputs['Emission Strength'].default_value
            corners=[]
            for li in tri.loops:
                p = transform @ mesh.vertices[mesh.loops[li].vertex_index].co
                n = normal_matrix @ mesh.corner_normals[li].vector
                p = Vector((p.x,p.z,-p.y)); n=Vector((n.x,n.z,-n.y)).normalized()
                points.append(p); corners.append((p,n))
            triangles.append((desc,corners))
        if key != 'pallet': evaluated.to_mesh_clear()
    low=Vector(tuple(min(p[i] for p in points) for i in range(3)))
    high=Vector(tuple(max(p[i] for p in points) for i in range(3)))
    size=high-low; center=(low+high)*.5
    groups={}
    for desc,corners in triangles:
        group=groups.setdefault(desc['name'],{'material':desc,'positions':[],'normals':[],'indices':[],'lookup':{}})
        for p,n in corners:
            pos=tuple(round((p[i]-center[i])/size[i],6) for i in range(3))
            normal=Vector(tuple(n[i]*size[i] for i in range(3))).normalized()
            normal=tuple(round(v,5) for v in normal)
            vertex=pos+normal
            if vertex not in group['lookup']:
                group['lookup'][vertex]=len(group['positions'])//3
                group['positions'].extend(pos);group['normals'].extend(normal)
            group['indices'].append(group['lookup'][vertex])
    for group in groups.values(): del group['lookup']
    assets[key]={'size':list(size),'parts':list(groups.values())}
with open(output,'w') as f: json.dump(assets,f,separators=(',',':'))
print('Exported',output,os.path.getsize(output),'bytes')
print({k:sum(len(p['indices'])//3 for p in a['parts']) for k,a in assets.items()})
