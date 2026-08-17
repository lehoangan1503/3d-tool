# ==========================================================
# build-cue-joint-fixed.py
#
# Ban SUA LOI cua script goc ("New Text Document.py").
# Chay trong Blender: Scripting > Open > Run Script
#
# VAN DE BAN GOC: joint cover dai 39.0mm (6.0 + 2.0 + 31.0),
# trong khi joint THUC TE cua model dang dung chi dai 31.5mm.
# Nguyen nhan: JOINT_GROOVE_LEN_MM bi hieu la "tong chieu dai joint",
# nhung trong code no duoc CONG THEM vao base + taper.
#
# CACH DO: thong so duoi day do truc tiep tu file dang chay tot
#   public/models/cue-butt-leather-lizard-ktx2.glb
#   node AI_CUE_joint_cover / mesh Cone.003 / 26,846 verts
#   (node scale 1000x, nen ban kinh local da nhan 1000 khi do)
#
# 4 THONG SO DA DOI (chi trong phan KHOP NOI):
#   JOINT_TAPER_LEN_MM   2.0  -> 1.5
#   JOINT_GROOVE_LEN_MM  31.0 -> 24.0
#   GROOVE_FROM_TOP_MM   4.5  -> 3.5
#   GROOVE_SPACING_MM    2.2  -> 3.0
#   TOP_SOFT_LEN_MM      1.2  -> 0.9
# Cac phan BODY / BUMPER / MESH / MATERIAL giu nguyen 100%.
#
# LUU Y VE VET XUOC: script nay chi tao HINH HOC, khong co texture.
# Vet xuoc tren joint nam trong texture roughness/metallic cua file GLB
# (Powder coated metal black_metallic), khong nam trong mesh. Nen model
# tao tu script nay se KHONG bi xuoc - vi no khong co roughness map.
# ==========================================================

import bpy
import math
import bmesh

# ==========================================================
# PARAMS - THONG SO CO THE DIEU CHINH
# ==========================================================

# ---------- KICH THUOC THAN GAY (BODY) ----------
BUTT_LENGTH_MM = 736.6          # Chieu dai than gay (mm)
BUTT_DIAM_BOTTOM_MM = 31.8      # Duong kinh day gay - phan to nhat (mm)
BUTT_DIAM_TOP_MM = 21.5         # Duong kinh dinh gay - phan nho nhat (mm)

# ---------- BO TRON DAY THAN GAY ----------
BODY_BOTTOM_FILLET_MM = 3.0     # Do rong bo tron day than (mm) - tang len = tron hon
BODY_BOTTOM_FILLET_SEG = 8      # So segment bo tron - tang len = muot hon (4-12)
BODY_BOTTOM_FILLET_PROFILE = 0.5  # Hinh dang bo tron: 0.5=tron deu, 0.9=goc mem, 1.0=goc cung

# ---------- KHOP NOI (JOINT COVER) ----------
# Cac thong so duoi day duoc DO TRUC TIEP tu file dang chay tot:
#   public/models/cue-butt-leather-lizard-ktx2.glb  (mesh Cone.003, 26846 verts)
# Tong chieu dai joint do duoc = 31.5mm (Y 634.50 -> 666.00)
# LUU Y: JOINT_GROOVE_LEN_MM KHONG phai tong chieu dai joint.
#   Tong = JOINT_BASE_LEN_MM + JOINT_TAPER_LEN_MM + JOINT_GROOVE_LEN_MM
#        = 6.0 + 1.5 + 24.0 = 31.5mm
# Ban goc dung 6.0 + 2.0 + 31.0 = 39.0mm -> joint DAI hon thuc te ~7.5mm.
JOINT_BASE_LEN_MM = 6.0         # Chieu dai phan day khop noi (mm) - do: 634.50->640.50
JOINT_TAPER_LEN_MM = 1.5        # Chieu dai phan vat nghieng (mm) - do: 640.50->642.00
JOINT_GROOVE_LEN_MM = 24.0      # Chieu dai phan ranh (mm) - do: 642.00->666.00
JOINT_TAPER_TO_DIAM_MM = 19.5   # Duong kinh sau vat nghieng (mm) - do: 19.500
JOINT_GROOVE_DIAM_MM = 19.5     # Duong kinh phan ranh (mm) - do: 19.500

# ---------- RANH TRANG TRI TREN KHOP NOI ----------
# Do duoc: 2 ranh tai Y=662.50 va Y=659.50, duong kinh day ranh 17.500
# => cach dinh (666.00) lan luot 3.5mm va 6.5mm, spacing 3.0mm
GROOVE_COUNT = 2                # So ranh trang tri
GROOVE_FROM_TOP_MM = 3.5        # Khoang cach tu dinh den ranh dau tien (mm)
GROOVE_SPACING_MM = 3.0         # Khoang cach giua cac ranh (mm)
GROOVE_WIDTH_MM = 1.2           # Do rong moi ranh (mm)
GROOVE_DEPTH_MM = 0.8           # Do sau moi ranh (mm) - GIU NGUYEN ban goc.
                                # Cutter: major_r = groove_r - DEPTH*0.5 = 9.35
                                # day ranh = (major_r - WIDTH/2)*2 = 17.50 -> khop chinh xac
                                # gia tri do duoc 17.500. Doi 0.8 se lam sai day ranh.

# ---------- PHAN LOM TREN DINH KHOP NOI ----------
# Do duoc: 665.00->665.90 chuyen tiep mem (19.5 -> 18.3)
#          665.90->666.00 buoc lom (18.3 -> 15.5)
TOP_RECESS_LEN_MM = 1.0         # Chieu dai phan lom (mm)
TOP_RECESS_DEPTH_MM = 2.0       # Do sau phan lom - do chenh ban kinh (mm) - do: 19.5->15.5
TOP_SOFT_ENABLE = True          # Bat/tat bo tron mem o dinh (True/False)
TOP_SOFT_LEN_MM = 0.9           # Chieu dai phan chuyen tiep mem (mm) - do: 665.00->665.90
TOP_SOFT_INSET_MM = 0.6         # Do thut vao cua phan chuyen tiep (mm) - do: 19.5->18.3

# ---------- NUT DAY (BUMPER) ----------
BUMPER_ENABLE = True            # Bat/tat nut day (True/False)
BUMPER_OUTER_DIAM_MM = 25.0     # Duong kinh ngoai nut day (mm)
BUMPER_TOTAL_LEN_MM = 10.0      # Chieu dai tong nut day (mm)
BUMPER_INSERT_MM = 5.0          # Phan am vao trong than gay (mm)
BUMPER_CLEARANCE_MM = 0.2       # Khe ho giua nut va than gay (mm)

# ---------- BO TRON CANH NUT DAY ----------
BUMPER_FILLET_MM = 2.0          # Do rong bo tron canh nut day (mm) - tang len = mem hon
BUMPER_FILLET_SEG = 6           # So segment bo tron nut day (4-8)

# ---------- CHAT LUONG MESH ----------
RADIAL_SEGMENTS = 512           # So segment theo chu vi (32=tho, 64=vua, 128=min)
BUTT_SUBDIV_CUTS = 10           # So lan chia nho than gay theo chieu dai

# ---------- MATERIAL (MAU SAC) ----------
USE_MATERIALS = True            # Bat/tat su dung material (True/False)
MAT_BODY_RGBA = (0.70, 0.70, 0.70, 1.0)    # Mau than gay (R, G, B, Alpha) - 0.0-1.0
MAT_JOINT_RGBA = (0.03, 0.03, 0.03, 1.0)   # Mau khop noi (den)
MAT_BUMPER_RGBA = (0.06, 0.06, 0.06, 1.0)  # Mau nut day (den nhat)

# ---------- KHAC ----------
PRESS_FIT_MM = 0.2              # Do am khop noi vao than gay (mm) - de khong bi ho
PREFIX = "AI_CUE_"              # Tien to ten cac object trong Blender


# ==========================================================
# HELPERS
# ==========================================================

def mm_to_m(mm):
    return mm / 1000.0

def set_units_mm():
    scn = bpy.context.scene
    scn.unit_settings.system = "METRIC"
    scn.unit_settings.scale_length = 0.001
    scn.unit_settings.length_unit = "MILLIMETERS"

def ensure_object_mode():
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")

def clear_previous():
    ensure_object_mode()
    for obj in list(bpy.data.objects):
        if obj.name.startswith(PREFIX):
            bpy.data.objects.remove(obj, do_unlink=True)

def select_active(obj):
    ensure_object_mode()
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

def shade_smooth(obj):
    select_active(obj)
    try:
        bpy.ops.object.shade_smooth()
    except:
        pass

def shade_flat(obj):
    select_active(obj)
    try:
        bpy.ops.object.shade_flat()
    except:
        pass

def recalc_normals(obj):
    select_active(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")

def boolean_difference(target, cutter):
    mod = target.modifiers.new(name="BoolDiff", type="BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.object = cutter
    select_active(target)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)

def join_objects(objs, active_obj):
    ensure_object_mode()
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active_obj
    bpy.ops.object.join()
    return bpy.context.active_object

def put_in_collection(objs):
    col = bpy.data.collections.get("AI_CUE")
    if not col:
        col = bpy.data.collections.new("AI_CUE")
        bpy.context.scene.collection.children.link(col)
    for obj in objs:
        if not obj:
            continue
        for c in list(obj.users_collection):
            c.objects.unlink(obj)
        col.objects.link(obj)

def get_or_create_mat(name, rgba):
    mat = bpy.data.materials.get(name)
    if not mat:
        mat = bpy.data.materials.new(name=name)
        mat.use_nodes = True
    if mat.use_nodes:
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = rgba
            bsdf.inputs["Roughness"].default_value = 0.45
    return mat

def assign_mat(obj, mat):
    if not USE_MATERIALS or not obj or not obj.data or not mat:
        return
    obj.data.materials.clear()
    obj.data.materials.append(mat)


# ==========================================================
# BEVEL / FINALIZE
# ==========================================================

def bevel_bottom_edge(obj, fillet_mm, segments, profile, z_eps_mm=0.5):
    ensure_object_mode()
    select_active(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.mesh.select_mode(type='EDGE')
    
    bm = bmesh.from_edit_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    
    zmin = min(v.co.z for v in bm.verts)
    eps = mm_to_m(z_eps_mm)
    outer_r = max(math.sqrt(v.co.x**2 + v.co.y**2) for v in bm.verts)
    r_eps = mm_to_m(1.0)
    
    for e in bm.edges:
        v0, v1 = e.verts
        at_bottom = abs(v0.co.z - zmin) < eps and abs(v1.co.z - zmin) < eps
        r0 = math.sqrt(v0.co.x**2 + v0.co.y**2)
        r1 = math.sqrt(v1.co.x**2 + v1.co.y**2)
        at_outer = abs(r0 - outer_r) < r_eps and abs(r1 - outer_r) < r_eps
        if at_bottom and at_outer:
            e.select = True
    
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.mesh.bevel(offset=mm_to_m(fillet_mm), segments=segments, profile=profile, affect='EDGES')
    bpy.ops.object.mode_set(mode="OBJECT")


def finalize_hard_surface(obj, angle_deg=30.0, protect_bottom=False, use_smooth=True):
    select_active(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bm = bmesh.from_edit_mesh(obj.data)
    zmax = max(v.co.z for v in bm.verts)
    zmin = min(v.co.z for v in bm.verts)
    top_faces = [f for f in bm.faces if all(abs(v.co.z - zmax) < 1e-6 for v in f.verts)]
    if top_faces:
        bmesh.ops.triangulate(bm, faces=top_faces)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.object.mode_set(mode="OBJECT")
    
    recalc_normals(obj)
    try:
        obj.data.use_auto_smooth = True
        obj.data.auto_smooth_angle = math.radians(angle_deg)
    except:
        pass
    
    select_active(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.mesh.select_mode(type='EDGE')
    
    # Chi mark sharp cac edge KHONG nam o vung day (neu protect_bottom=True)
    bm = bmesh.from_edit_mesh(obj.data)
    bm.edges.ensure_lookup_table()
    bm.verts.ensure_lookup_table()
    
    threshold = math.radians(angle_deg)
    bottom_zone = mm_to_m(10.0)  # vung 10mm tu day
    
    for e in bm.edges:
        # Tinh goc giua 2 face
        if len(e.link_faces) == 2:
            angle = e.calc_face_angle()
            if angle and angle > threshold:
                # Kiem tra neu o vung day thi bo qua
                if protect_bottom:
                    v0, v1 = e.verts
                    near_bottom = (v0.co.z - zmin) < bottom_zone or (v1.co.z - zmin) < bottom_zone
                    if near_bottom:
                        continue
                e.select = True
    
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.mesh.mark_sharp()
    bpy.ops.object.mode_set(mode="OBJECT")
    
    # Chon smooth hoac flat
    if use_smooth:
        shade_smooth(obj)
    else:
        shade_flat(obj)


# ==========================================================
# BUILD FUNCTIONS
# ==========================================================

def build_butt_body(mat_body=None):
    length_m = mm_to_m(BUTT_LENGTH_MM)
    r_bottom = mm_to_m(BUTT_DIAM_BOTTOM_MM) / 2.0
    r_top = mm_to_m(BUTT_DIAM_TOP_MM) / 2.0

    bpy.ops.mesh.primitive_cone_add(
        vertices=RADIAL_SEGMENTS,
        radius1=r_bottom, radius2=r_top,
        depth=length_m, end_fill_type="NGON",
        location=(0, 0, length_m / 2.0)
    )
    body = bpy.context.active_object
    body.name = PREFIX + "butt_body"

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.subdivide(number_cuts=BUTT_SUBDIV_CUTS)
    bpy.ops.object.mode_set(mode="OBJECT")

    shade_smooth(body)
    recalc_normals(body)
    assign_mat(body, mat_body)
    return body


def build_joint_cover(body_top_z_m, mat_joint=None):
    base_len = mm_to_m(JOINT_BASE_LEN_MM)
    taper_len = mm_to_m(JOINT_TAPER_LEN_MM)
    groove_len = mm_to_m(JOINT_GROOVE_LEN_MM)

    base_r = mm_to_m(BUTT_DIAM_TOP_MM) / 2.0
    taper_r2 = mm_to_m(JOINT_TAPER_TO_DIAM_MM) / 2.0
    groove_r = mm_to_m(JOINT_GROOVE_DIAM_MM) / 2.0

    top_step_len = mm_to_m(TOP_RECESS_LEN_MM)
    top_step_inset = mm_to_m(TOP_RECESS_DEPTH_MM)
    top_step_len = max(mm_to_m(0.1), min(top_step_len, groove_len - mm_to_m(0.1)))
    top_step_r = max(mm_to_m(0.2), groove_r - top_step_inset)

    z = body_top_z_m

    bpy.ops.mesh.primitive_cylinder_add(vertices=RADIAL_SEGMENTS, radius=base_r, depth=base_len, location=(0, 0, z + base_len/2))
    base = bpy.context.active_object
    base.name = PREFIX + "joint_base"
    z += base_len

    bpy.ops.mesh.primitive_cone_add(vertices=RADIAL_SEGMENTS, radius1=base_r, radius2=taper_r2, depth=taper_len, end_fill_type="NGON", location=(0, 0, z + taper_len/2))
    taper = bpy.context.active_object
    taper.name = PREFIX + "joint_taper"
    z += taper_len

    gro_main_len = groove_len - top_step_len
    bpy.ops.mesh.primitive_cylinder_add(vertices=RADIAL_SEGMENTS, radius=groove_r, depth=gro_main_len, location=(0, 0, z + gro_main_len/2))
    gro_main = bpy.context.active_object
    gro_main.name = PREFIX + "joint_groove_main"

    top_soft_len = mm_to_m(TOP_SOFT_LEN_MM)
    soft_r = max(mm_to_m(0.2), groove_r - mm_to_m(TOP_SOFT_INSET_MM))
    if TOP_SOFT_ENABLE:
        top_soft_len = max(mm_to_m(0.1), min(top_soft_len, top_step_len - mm_to_m(0.1)))
    else:
        top_soft_len = 0.0
    top_step_remain = top_step_len - top_soft_len
    top_soft = None

    if TOP_SOFT_ENABLE:
        bpy.ops.mesh.primitive_cone_add(vertices=RADIAL_SEGMENTS, radius1=groove_r, radius2=soft_r, depth=top_soft_len, end_fill_type="NGON", location=(0, 0, z + gro_main_len + top_soft_len/2))
        top_soft = bpy.context.active_object
        top_soft.name = PREFIX + "joint_top_soft"

    z_topstart = z + gro_main_len + top_soft_len
    start_r = soft_r if TOP_SOFT_ENABLE else groove_r
    if abs(start_r - top_step_r) > 1e-9:
        bpy.ops.mesh.primitive_cone_add(vertices=RADIAL_SEGMENTS, radius1=start_r, radius2=top_step_r, depth=top_step_remain, end_fill_type="NGON", location=(0, 0, z_topstart + top_step_remain/2))
    else:
        bpy.ops.mesh.primitive_cylinder_add(vertices=RADIAL_SEGMENTS, radius=top_step_r, depth=top_step_remain, location=(0, 0, z_topstart + top_step_remain/2))
    gro_top = bpy.context.active_object
    gro_top.name = PREFIX + "joint_groove_topstep"

    top_z_main = z + gro_main_len
    for i in range(GROOVE_COUNT):
        groove_z = (z + groove_len) - mm_to_m(GROOVE_FROM_TOP_MM) - i * mm_to_m(GROOVE_SPACING_MM)
        if groove_z > top_z_main - mm_to_m(0.2):
            groove_z = top_z_main - mm_to_m(0.2) - i * mm_to_m(GROOVE_SPACING_MM)
        major = max(mm_to_m(0.5), groove_r - mm_to_m(GROOVE_DEPTH_MM) * 0.5)
        minor = max(mm_to_m(0.2), mm_to_m(GROOVE_WIDTH_MM) / 2.0)
        bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=max(24, RADIAL_SEGMENTS), minor_segments=24, location=(0, 0, groove_z))
        tor = bpy.context.active_object
        tor.name = PREFIX + "joint_groove_cut_" + str(i)
        boolean_difference(gro_main, tor)

    parts = [base, taper, gro_main]
    if TOP_SOFT_ENABLE and top_soft:
        parts.append(top_soft)
    parts.append(gro_top)

    joint = join_objects(parts, active_obj=gro_top)
    joint.name = PREFIX + "joint_cover"
    joint.location.z -= mm_to_m(PRESS_FIT_MM)

    finalize_hard_surface(joint, 25.0)
    assign_mat(joint, mat_joint)
    return joint


def build_bumper_simple(mat_bumper=None):
    """
    Tao bumper don gian: cylinder + Bevel Modifier.
    Bevel se tu dong bo tron cac canh 90 do (top va bottom).
    """
    outer_r = mm_to_m(BUMPER_OUTER_DIAM_MM) / 2.0
    total_len = mm_to_m(BUMPER_TOTAL_LEN_MM)
    insert = mm_to_m(BUMPER_INSERT_MM)
    clearance = mm_to_m(BUMPER_CLEARANCE_MM)
    
    # Vi tri: day tai z = insert - total_len, dinh tai z = insert
    center_z = insert - total_len / 2.0
    
    # Tao cylinder
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=RADIAL_SEGMENTS,
        radius=outer_r,
        depth=total_len,
        location=(0, 0, center_z)
    )
    bumper = bpy.context.active_object
    bumper.name = PREFIX + "bumper"
    
    # Ap dung Bevel Modifier TRUOC khi boolean
    # Dung ANGLE limit de chi bo tron cac canh goc 90 do
    mod = bumper.modifiers.new(name="Bevel", type="BEVEL")
    mod.width = mm_to_m(BUMPER_FILLET_MM)
    mod.segments = BUMPER_FILLET_SEG
    mod.profile = 0.5  # 0.5 = tron deu
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(60)  # chi bo cac canh goc > 60 do
    mod.affect = 'EDGES'
    
    # Apply bevel modifier
    select_active(bumper)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    
    # Boolean khoet socket
    body_r_bottom = mm_to_m(BUTT_DIAM_BOTTOM_MM) / 2.0
    socket_r = body_r_bottom + clearance
    socket_depth = max(mm_to_m(0.5), insert)
    
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=RADIAL_SEGMENTS,
        radius=socket_r,
        depth=socket_depth,
        location=(0, 0, insert - socket_depth/2)
    )
    socket = bpy.context.active_object
    socket.name = PREFIX + "bumper_socket"
    boolean_difference(bumper, socket)
    
    # Bevel vien trong (mieng socket) sau boolean
    select_active(bumper)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.mesh.select_mode(type='EDGE')
    
    bm = bmesh.from_edit_mesh(bumper.data)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    
    # Tim vien trong o dinh (z gan insert, radius gan socket_r)
    zmax = max(v.co.z for v in bm.verts)
    z_eps = mm_to_m(0.5)
    
    for e in bm.edges:
        v0, v1 = e.verts
        # Kiem tra edge nam o dinh
        at_top = abs(v0.co.z - zmax) < z_eps and abs(v1.co.z - zmax) < z_eps
        # Kiem tra edge nam o vien trong (gan socket_r)
        r0 = math.sqrt(v0.co.x**2 + v0.co.y**2)
        r1 = math.sqrt(v1.co.x**2 + v1.co.y**2)
        at_inner = abs(r0 - socket_r) < mm_to_m(1.0) and abs(r1 - socket_r) < mm_to_m(1.0)
        
        if at_top and at_inner:
            e.select = True
    
    bmesh.update_edit_mesh(bumper.data)
    
    # Bevel vien trong voi do rong lon hon
    bpy.ops.mesh.bevel(
        offset=mm_to_m(BUMPER_FILLET_MM * 1.5),  # rong hon vien ngoai
        segments=BUMPER_FILLET_SEG,
        profile=0.5,
        affect='EDGES'
    )
    bpy.ops.object.mode_set(mode="OBJECT")
    
    shade_smooth(bumper)
    recalc_normals(bumper)
    assign_mat(bumper, mat_bumper)
    
    return bumper


# ==========================================================
# MAIN
# ==========================================================

def build():
    set_units_mm()
    ensure_object_mode()
    clear_previous()

    mat_body = get_or_create_mat("Mat_Body", MAT_BODY_RGBA) if USE_MATERIALS else None
    mat_joint = get_or_create_mat("Mat_JointCover", MAT_JOINT_RGBA) if USE_MATERIALS else None
    mat_bumper = get_or_create_mat("Mat_Bumper", MAT_BUMPER_RGBA) if USE_MATERIALS else None

    body = build_butt_body(mat_body)
    bevel_bottom_edge(body, BODY_BOTTOM_FILLET_MM, BODY_BOTTOM_FILLET_SEG, BODY_BOTTOM_FILLET_PROFILE)
    body_top_z = mm_to_m(BUTT_LENGTH_MM)

    joint_cover = build_joint_cover(body_top_z, mat_joint)

    bumper = None
    if BUMPER_ENABLE:
        bumper = build_bumper_simple(mat_bumper)

    finalize_hard_surface(body, 60.0, protect_bottom=True, use_smooth=True)
    put_in_collection([body, joint_cover, bumper])


build()
