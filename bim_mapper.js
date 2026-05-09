/**
 * BIMAccessibilityMapper — JavaScript port of bim_mapper.py
 * Uses web-ifc (WebAssembly) for IFC parsing. No server required.
 */
class BIMAccessibilityMapper {
  constructor(ifcApi) {
    this.ifcApi  = ifcApi;
    this.modelID = null;

    // Graph
    this.G = { nodes: new Map(), edges: new Map(), adj: new Map() };

    // Storeys
    this.storeyElevByName = {};
    this._sortedStoreys   = [];   // [{name, elev}]

    // Internal helpers
    this._geomCache      = new Map();  // expressID -> [[x,y,z],...]
    this._containerOf    = new Map();  // expressID -> storey name
    this._spacesData     = [];
    this._bbox2dBySpace  = new Map();
    this._doorsByLevel   = {};         // lvl -> [{id,x,y,z}]
    this._storeyPolylines = {};        // lvl -> [[[x,y],[x,y]],...]
  }

  // ═══════════════════════════════════════════════════════
  // LOAD
  // ═══════════════════════════════════════════════════════
  async loadArrayBuffer(buffer) {
    this.modelID = this.ifcApi.OpenModel(new Uint8Array(buffer));
    this._extractStoreys();
    this._buildContainerIndex();
    this._inferElevsIfNeeded();   // fallback when Elevation attr = 0 for all storeys
  }

  // ═══════════════════════════════════════════════════════
  // STOREYS
  // ═══════════════════════════════════════════════════════
  _extractStoreys() {
    const ids = this.ifcApi.GetLineIDsWithType(this.modelID, WebIFC.IFCBUILDINGSTOREY);
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      const st = this.ifcApi.GetLine(this.modelID, id, true);
      const name = this._sv(st.Name) || 'Nivel Desconocido';
      let elev = 0;

      // ── Método 1: atributo Elevation ──────────────────────────────────
      try { elev = parseFloat(st.Elevation?.value ?? st.Elevation ?? 0) || 0; } catch (_) {}

      // ── Método 2: ObjectPlacement resuelto por recursive GetLine ──────
      if (elev === 0) {
        try {
          const rp = st.ObjectPlacement?.RelativePlacement
                  ?? st.ObjectPlacement?.PlacementRelTo?.RelativePlacement;
          if (rp) {
            const loc = rp.Location?.Coordinates ?? rp.Location;
            if (Array.isArray(loc) && loc.length >= 3) {
              const z = parseFloat(loc[2]?.value ?? loc[2]);
              if (!isNaN(z) && z !== 0) elev = z;
            }
          }
        } catch (_) {}
      }

      // ── Método 3: traversal manual de referencias (expresIDs) ─────────
      // Necesario cuando GetLine(recursive) no resuelve ObjectPlacement
      // en la build IIFE de web-ifc
      if (elev === 0) {
        try {
          const stRaw = this.ifcApi.GetLine(this.modelID, id, false);
          const opRef = stRaw.ObjectPlacement?.value ?? stRaw.ObjectPlacement;
          if (typeof opRef === 'number') {
            const lp = this.ifcApi.GetLine(this.modelID, opRef, false);
            const rpRef = lp.RelativePlacement?.value ?? lp.RelativePlacement;
            if (typeof rpRef === 'number') {
              const ap = this.ifcApi.GetLine(this.modelID, rpRef, false);
              const locRef = ap.Location?.value ?? ap.Location;
              if (typeof locRef === 'number') {
                const cp = this.ifcApi.GetLine(this.modelID, locRef, false);
                const coords = cp.Coordinates;
                if (Array.isArray(coords) && coords.length >= 3) {
                  const z = parseFloat(coords[2]?.value ?? coords[2]);
                  if (!isNaN(z) && z !== 0) elev = z;
                }
              }
            }
          }
        } catch (_) {}
      }

      // Debug: loguear cada planta para diagnóstico en consola del navegador
      console.log(`[Storey] "${name}" id=${id}  Elevation=${JSON.stringify(st.Elevation)}  elev_final=${elev}`);
      this.storeyElevByName[name] = elev;
    }
    if (!Object.keys(this.storeyElevByName).length)
      this.storeyElevByName['Nivel 0'] = 0;
    this._sortedStoreys = Object.entries(this.storeyElevByName)
      .map(([name, elev]) => ({ name, elev }))
      .sort((a, b) => a.elev - b.elev);
    console.log('[BIMMapper] Plantas (tras _extractStoreys):',
      this._sortedStoreys.map(s => `${s.name}=${s.elev}m`).join(', '));
  }

  // ─── Fallback: inferir cotas cuando _extractStoreys obtiene todas a 0 ───────
  _inferElevsIfNeeded() {
    const allSame = this._sortedStoreys.length < 2 ||
      this._sortedStoreys.every(s => s.elev === this._sortedStoreys[0].elev);
    if (!allSame) return;   // las cotas ya son distintas → no hacer nada

    console.log('[BIMMapper] Todas las cotas iguales, intentando inferir…');

    // ── Método A: mínimo Z de la geometría de los espacios ────────────────
    const buckets = {};
    try {
      const spIds = this.ifcApi.GetLineIDsWithType(this.modelID, WebIFC.IFCSPACE);
      for (let i = 0; i < spIds.size(); i++) {
        const eid = spIds.get(i);
        const stName = this._containerOf.get(eid);
        if (!stName) continue;
        const verts = this.getElementVertices(eid);
        if (!verts.length) continue;
        const minZ = Math.min(...verts.map(v => v[2]));
        if (!buckets[stName]) buckets[stName] = [];
        buckets[stName].push(minZ);
      }
    } catch (_) {}

    const allZ = Object.values(buckets).flat();
    const geomSpread = allZ.length >= 2
      ? Math.max(...allZ) - Math.min(...allZ) : 0;

    if (geomSpread > 0.5) {
      // Geometría tiene dispersión Z útil → usarla como cota de planta
      for (const [name, vals] of Object.entries(buckets)) {
        vals.sort((a, b) => a - b);
        this.storeyElevByName[name] = vals[Math.max(0, Math.floor(vals.length * 0.10))];
      }
      console.log('[BIMMapper] Cotas inferidas desde geometría:',
        JSON.stringify(this.storeyElevByName));
    } else {
      // ── Método B: alturas secuenciales basadas en el orden de la lista ──
      // El orden de inserción en _extractStoreys es generalmente de abajo a arriba.
      // Intentamos deducir la altura típica de planta a partir de escaleras.
      let floorH = 3.5;
      try {
        const stairIds = this.ifcApi.GetLineIDsWithType(this.modelID, WebIFC.IFCSTAIRFLIGHT);
        for (let i = 0; i < stairIds.size(); i++) {
          const v = this.getElementVertices(stairIds.get(i));
          if (!v.length) continue;
          const h = Math.max(...v.map(p => p[2])) - Math.min(...v.map(p => p[2]));
          if (h >= 2.0 && h <= 6.0) { floorH = h; break; }
        }
      } catch (_) {}

      // Calcular cota de partida: el primer piso se queda en 0 salvo que
      // haya un piso negativo (sótano) en el nombre
      let startIdx = 0;
      const names = this._sortedStoreys.map(s => s.name.toUpperCase());
      // Detectar si el primer piso es un sótano/nivel negativo por nombre
      const basementKW = ['-1','-2','SOTANO','SÓTANO','BASEMENT','KELLERGESCHOSS',
                          'SOUTERRAIN','SOTERRANI','UNDERGROUND'];
      for (let i = 0; i < names.length; i++) {
        if (!basementKW.some(k => names[i].includes(k))) { startIdx = i; break; }
      }
      // Asignar: pisos por debajo del "0" tienen cota negativa
      this._sortedStoreys.forEach((s, i) => {
        this.storeyElevByName[s.name] = (i - startIdx) * floorH;
      });
      console.log(`[BIMMapper] Cotas secuenciales (floorH=${floorH.toFixed(2)}, startIdx=${startIdx}):`,
        this._sortedStoreys.map(s => `${s.name}=${this.storeyElevByName[s.name].toFixed(1)}m`).join(', '));
    }

    // Actualizar lista ordenada
    this._sortedStoreys = Object.entries(this.storeyElevByName)
      .map(([name, elev]) => ({ name, elev }))
      .sort((a, b) => a.elev - b.elev);
    console.log('[BIMMapper] Plantas definitivas:',
      this._sortedStoreys.map(s => `${s.name}=${s.elev.toFixed(2)}m`).join(', '));
  }

  // ═══════════════════════════════════════════════════════
  // CONTAINER INDEX  (element → storey name)
  // ═══════════════════════════════════════════════════════
  _buildContainerIndex() {
    // ── Método 1: IfcRelContainedInSpatialStructure ───────────────────────
    // IMPORTANTE: usar recursive=FALSE para que RelatingStructure y
    // RelatedElements lleguen como {value: expressID} numéricos.
    // Con recursive=true el objeto ya viene resuelto y .value es undefined,
    // lo que hace que GetLineType reciba 0 → "Invalid ExpressID".
    try {
      const rels = this.ifcApi.GetLineIDsWithType(
        this.modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE
      );
      for (let i = 0; i < rels.size(); i++) {
        const rel  = this.ifcApi.GetLine(this.modelID, rels.get(i), false);
        const stId = rel.RelatingStructure?.value ?? rel.RelatingStructure;
        if (typeof stId !== 'number') continue;
        let stName = null;
        try {
          if (this.ifcApi.GetLineType(this.modelID, stId) === WebIFC.IFCBUILDINGSTOREY) {
            const st = this.ifcApi.GetLine(this.modelID, stId, false);
            stName = this._sv(st.Name) || 'Nivel Desconocido';
          }
        } catch (_) {}
        if (!stName) continue;
        const items = rel.RelatedElements;
        for (const item of (Array.isArray(items) ? items : [items])) {
          const eid = item?.value ?? item;
          if (typeof eid === 'number') this._containerOf.set(eid, stName);
        }
      }
    } catch (_) {}

    // ── Método 2: IfcRelAggregates ────────────────────────────────────────
    try {
      const rels = this.ifcApi.GetLineIDsWithType(this.modelID, WebIFC.IFCRELAGGREGATES);
      for (let i = 0; i < rels.size(); i++) {
        const rel = this.ifcApi.GetLine(this.modelID, rels.get(i), false);
        const stId = rel.RelatingObject?.value ?? rel.RelatingObject;
        if (typeof stId !== 'number') continue;
        let stName = null;
        try {
          if (this.ifcApi.GetLineType(this.modelID, stId) === WebIFC.IFCBUILDINGSTOREY) {
            const st = this.ifcApi.GetLine(this.modelID, stId, false);
            stName = this._sv(st.Name) || 'Nivel Desconocido';
          }
        } catch (_) {}
        if (!stName) continue;
        const items = rel.RelatedObjects;
        for (const item of (Array.isArray(items) ? items : [items])) {
          const eid = item?.value ?? item;
          if (typeof eid === 'number' && !this._containerOf.has(eid))
            this._containerOf.set(eid, stName);
        }
      }
    } catch (_) {}

    console.log(`[BIMMapper] _containerOf: ${this._containerOf.size} elementos mapeados a planta`);
    // Muestra un resumen: cuántos elementos por planta
    const countByStorey = {};
    for (const name of this._containerOf.values())
      countByStorey[name] = (countByStorey[name] || 0) + 1;
    console.log('[BIMMapper] Elementos por planta:', JSON.stringify(countByStorey));
  }

  // ═══════════════════════════════════════════════════════
  // GEOMETRY
  // ═══════════════════════════════════════════════════════
  getElementVertices(eid) {
    if (this._geomCache.has(eid)) return this._geomCache.get(eid);
    const all = [];
    try {
      this.ifcApi.StreamMeshes(this.modelID, [eid], (mesh) => {
        const n = mesh.geometries.size();
        for (let i = 0; i < n; i++) {
          const g = mesh.geometries.get(i);
          const M = g.flatTransformation;   // col-major Float64Array[16]
          try {
            const gd = this.ifcApi.GetGeometry(this.modelID, g.geometryExpressID);
            const vd = this.ifcApi.GetVertexArray(gd.GetVertexData(), gd.GetVertexDataSize());
            // stride 6: [x,y,z, nx,ny,nz]
            for (let j = 0; j < vd.length; j += 6) {
              const lx = vd[j], ly = vd[j+1], lz = vd[j+2];
              all.push([
                M[0]*lx + M[4]*ly + M[8]*lz  + M[12],
                M[1]*lx + M[5]*ly + M[9]*lz  + M[13],
                M[2]*lx + M[6]*ly + M[10]*lz + M[14],
              ]);
            }
            gd.delete();
          } catch (_) {}
        }
      });
    } catch (_) {}

    // Fallback: si StreamMeshes no devuelve vértices, leer la colocación
    // directamente desde la entidad IFC (da al menos el punto de inserción)
    if (all.length === 0) {
      try {
        const el  = this.ifcApi.GetLine(this.modelID, eid, true);
        const pl  = el?.ObjectPlacement?.RelativePlacement
                 ?? el?.ObjectPlacement?.PlacementRelTo?.RelativePlacement;
        if (pl) {
          const loc = pl.Location?.Coordinates ?? pl.Location;
          if (Array.isArray(loc) && loc.length >= 2) {
            const x = parseFloat(loc[0]?.value ?? loc[0]) || 0;
            const y = parseFloat(loc[1]?.value ?? loc[1]) || 0;
            const z = parseFloat(loc[2]?.value ?? loc[2]) || 0;
            // Insertar un bbox mínimo (1 cm) para que el centroide sea correcto
            all.push([x-0.005,y-0.005,z], [x+0.005,y+0.005,z+0.005]);
          }
        }
      } catch (_) {}
    }

    this._geomCache.set(eid, all);
    return all;
  }

  getElementCentroidAndBbox(eid) {
    const v = this.getElementVertices(eid);
    if (!v.length) return { centroid: null, bbox: null };
    const xs = v.map(p => p[0]), ys = v.map(p => p[1]), zs = v.map(p => p[2]);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.min(...zs),
                  Math.max(...xs), Math.max(...ys), Math.max(...zs)];
    const centroid = [
      xs.reduce((a, b) => a + b, 0) / xs.length,
      ys.reduce((a, b) => a + b, 0) / ys.length,
      zs.reduce((a, b) => a + b, 0) / zs.length,
    ];
    return { centroid, bbox };
  }

  snapZToLevel(z) {
    let best = this._sortedStoreys[0];
    for (const st of this._sortedStoreys)
      if (Math.abs(z - st.elev) < Math.abs(z - best.elev)) best = st;
    return best;   // {name, elev}
  }

  elementStoreyName(eid) {
    if (this._containerOf.has(eid)) return this._containerOf.get(eid);
    const { centroid, bbox } = this.getElementCentroidAndBbox(eid);
    // Z-up model: IFC Z = elevation, use bbox[2] (minZ) for level snap
    if (bbox)     return this.snapZToLevel(bbox[2]).name;
    if (centroid) return this.snapZToLevel(centroid[2]).name;
    return 'Nivel Desconocido';
  }

  // ═══════════════════════════════════════════════════════
  // MATH HELPERS
  // ═══════════════════════════════════════════════════════
  _d2d(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  _bbox2dContains(xy, b, tol = 0.3) {
    return xy[0] >= b[0]-tol && xy[0] <= b[2]+tol &&
           xy[1] >= b[1]-tol && xy[1] <= b[3]+tol;
  }

  _bbox2dDist(xy, b) {
    return Math.hypot(
      Math.max(b[0] - xy[0], 0, xy[0] - b[2]),
      Math.max(b[1] - xy[1], 0, xy[1] - b[3])
    );
  }

  _checkProx(pt, bbox, tol = 0.5) {
    return pt[0] >= bbox[0]-tol && pt[0] <= bbox[3]+tol &&
           pt[1] >= bbox[1]-tol && pt[1] <= bbox[4]+tol &&
           pt[2] >= bbox[2]-tol && pt[2] <= bbox[5]+tol;
  }

  _norm2d(v) {
    const n = Math.hypot(v[0], v[1]);
    return n < 1e-9 ? null : [v[0]/n, v[1]/n];
  }

  _principalAxis(pts) {
    if (pts.length < 2) return null;
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const sxx = pts.reduce((s, p) => s + (p[0]-mx)**2, 0);
    const syy = pts.reduce((s, p) => s + (p[1]-my)**2, 0);
    const sxy = pts.reduce((s, p) => s + (p[0]-mx)*(p[1]-my), 0);
    const tr  = sxx + syy;
    const disc = Math.max(tr*tr/4 - (sxx*syy - sxy*sxy), 0);
    const eig  = tr/2 + Math.sqrt(disc);
    let vx = sxy, vy = eig - sxx;
    if (Math.abs(vx) < 1e-9 && Math.abs(vy) < 1e-9)
      [vx, vy] = sxx >= syy ? [1, 0] : [0, 1];
    return this._norm2d([vx, vy]);
  }

  // ═══════════════════════════════════════════════════════
  // DOOR FRAME
  // ═══════════════════════════════════════════════════════
  _doorFrame(eid) {
    const v = this.getElementVertices(eid);
    const zs = v.map(p => p[2]);   // IFC Z = elevation
    if (!zs.length) return { axis: [1, 0], normal: [0, 1] };
    const minZ = Math.min(...zs);
    // Use X and Y (horizontal axes in Z-up model) for door orientation
    const low  = v.filter(p => p[2] <= minZ + 0.4).map(p => [p[0], p[1]]);
    const axis = this._principalAxis(low.length >= 2 ? low : v.map(p => [p[0], p[1]])) || [1, 0];
    return { axis, normal: [-axis[1], axis[0]] };
  }

  _orthoFromDoor(dxy, txy, axis, norm) {
    const dx = txy[0]-dxy[0], dy = txy[1]-dxy[1];
    const dot = dx*norm[0] + dy*norm[1];
    const nx = dot >= 0 ? norm[0] : -norm[0];
    const ny = dot >= 0 ? norm[1] : -norm[1];
    const t  = dx*nx + dy*ny;
    const px = dxy[0]+t*nx, py = dxy[1]+t*ny;
    const pts = [dxy];
    if (this._d2d(dxy, [px, py]) > 1e-6) pts.push([px, py]);
    if (this._d2d([px, py], txy) > 1e-6) pts.push(txy);
    if (pts.length === 1) pts.push(txy);
    return pts;
  }

  _orthoXY(src, dst) {
    const mid = [dst[0], src[1]];
    const pts = [src];
    if (this._d2d(src, mid) > 1e-6) pts.push(mid);
    if (this._d2d(mid, dst) > 1e-6) pts.push(dst);
    if (pts.length === 1) pts.push(dst);
    return pts;
  }

  // ═══════════════════════════════════════════════════════
  // GRAPH PRIMITIVES
  // ═══════════════════════════════════════════════════════
  _addNode(id, data) {
    this.G.nodes.set(id, data);
    if (!this.G.adj.has(id)) this.G.adj.set(id, new Map());
  }

  _addEdge(u, v, data) {
    const key = u < v ? `${u}|||${v}` : `${v}|||${u}`;
    this.G.edges.set(key, { u, v, ...data });
    if (!this.G.adj.has(u)) this.G.adj.set(u, new Map());
    if (!this.G.adj.has(v)) this.G.adj.set(v, new Map());
    this.G.adj.get(u).set(v, data);
    this.G.adj.get(v).set(u, data);
  }

  _hasEdge(u, v) { return this.G.adj.has(u) && this.G.adj.get(u).has(v); }

  _addEdgePolyline(u, v, coords, weight = 1.0, accessible = true, edgeType = 'camino') {
    if (coords.length < 2) return;
    const lu = this.G.nodes.get(u)?.level || '';
    const lv = this.G.nodes.get(v)?.level || '';
    const levels = [...new Set([lu, lv])].sort().join('|');
    this._addEdge(u, v, { weight, accessible, edgeType, coords, levels });
  }

  _linkDoorSpace(doorId, sp, w, acc) {
    const dn = this.G.nodes.get(doorId), sn = this.G.nodes.get(sp.id);
    const pts2d = this._orthoFromDoor([dn.x, dn.y], [sn.x, sn.y], dn.wallAxis, dn.wallNormal);
    this._addEdgePolyline(doorId, sp.id, pts2d.map(([x,y]) => [x,y,dn.z]), w, acc, 'puerta_espacio');
  }

  _linkVertSpace(nid, sp, w = 1.0, acc = true) {
    const a = this.G.nodes.get(nid), b = this.G.nodes.get(sp.id);
    const pts2d = this._orthoXY([a.x, a.y], [b.x, b.y]);
    this._addEdgePolyline(nid, sp.id, pts2d.map(([x,y]) => [x,y,a.z]), w, acc, 'vertical_espacio');
  }

  _linkVertDoor(nid, did, w = 1.0, acc = true) {
    const vn = this.G.nodes.get(nid), dn = this.G.nodes.get(did);
    const pts2d = [...this._orthoFromDoor([dn.x,dn.y],[vn.x,vn.y],dn.wallAxis,dn.wallNormal)].reverse();
    this._addEdgePolyline(nid, did, pts2d.map(([x,y]) => [x,y,vn.z]), w, acc, 'vertical_puerta');
  }

  // ═══════════════════════════════════════════════════════
  // FLOOR PLAN OUTLINE
  // ═══════════════════════════════════════════════════════
  // Devuelve los 4 segmentos del rectángulo orientado (OBB) de la base del muro.
  // Usar el OBB en lugar de todos los vértices evita líneas internas de la
  // triangulación del mesh y funciona con muros a cualquier ángulo.
  _lowEdges(eid) {
    const verts = this.getElementVertices(eid);
    if (!verts.length) return [];
    // Z-up model: IFC Z = elevation. Filter base vertices (lowest Z = floor level).
    // Use X and Y (the two horizontal axes) for the 2D floor plan outline.
    const zs  = verts.map(v => v[2]);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const yTol = Math.max((maxZ - minZ) * 0.05, 0.10);
    const low  = verts.filter(v => v[2] <= minZ + yTol).map(v => [v[0], v[1]]);

    // Deduplicar a 1 cm de precisión
    const seen = new Set(), uniq = [];
    for (const p of low) {
      const k = `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
      if (!seen.has(k)) { seen.add(k); uniq.push(p); }
    }
    if (uniq.length < 2) return [];

    // Eje principal del muro por PCA
    const axis = this._principalAxis(uniq) || [1, 0];
    const perp = [-axis[1], axis[0]];

    // Centroide
    const cx = uniq.reduce((s,p) => s+p[0], 0) / uniq.length;
    const cy = uniq.reduce((s,p) => s+p[1], 0) / uniq.length;

    // Proyección sobre eje principal y perpendicular
    const u = uniq.map(p => (p[0]-cx)*axis[0] + (p[1]-cy)*axis[1]);
    const v = uniq.map(p => (p[0]-cx)*perp[0] + (p[1]-cy)*perp[1]);
    const uMin=Math.min(...u), uMax=Math.max(...u);
    const vMin=Math.min(...v), vMax=Math.max(...v);

    // OBB demasiado pequeño → ignorar
    if (uMax-uMin < 0.05 && vMax-vMin < 0.05) return [];

    // 4 esquinas del OBB en coordenadas del mundo
    const C = (du, dv) => [
      cx + du*axis[0] + dv*perp[0],
      cy + du*axis[1] + dv*perp[1],
    ];
    const corners = [C(uMin,vMin), C(uMax,vMin), C(uMax,vMax), C(uMin,vMax)];

    // 4 segmentos del rectángulo
    return [
      [corners[0], corners[1]],
      [corners[1], corners[2]],
      [corners[2], corners[3]],
      [corners[3], corners[0]],
    ].filter(([a,b]) => this._d2d(a,b) > 0.05);
  }

  _collectFloorplans() {
    const seen = new Set();
    for (const wtype of [WebIFC.IFCWALL, WebIFC.IFCWALLSTANDARDCASE, WebIFC.IFCCURTAINWALL]) {
      try {
        const ids = this.ifcApi.GetLineIDsWithType(this.modelID, wtype);
        for (let i = 0; i < ids.size(); i++) {
          const wid = ids.get(i);
          const lvl = this.elementStoreyName(wid);
          const key = `${wid}|${lvl}`;
          if (seen.has(key)) continue;
          seen.add(key);
          for (const line of this._lowEdges(wid)) {
            if (!this._storeyPolylines[lvl]) this._storeyPolylines[lvl] = [];
            this._storeyPolylines[lvl].push(line);
          }
        }
      } catch (_) {}
    }
  }

  // ═══════════════════════════════════════════════════════
  // IFC VALUE HELPERS
  // ═══════════════════════════════════════════════════════
  _sv(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return String(v.value ?? v);
  }
  _fv(v, def = 0) {
    if (v == null) return def;
    const n = parseFloat(v.value ?? v);
    return isNaN(n) ? def : n;
  }

  // ═══════════════════════════════════════════════════════
  // LIFT DETECTION
  // ═══════════════════════════════════════════════════════
  _findLifts() {
    const KW = ['ELEVATOR','LIFT','ELEVADOR','ASCENSOR','ASCENSORE','FAHRSTUHL','AUFZUG'];
    const SKIP = ['ESCALATOR','MOVINGWALKWAY','CRANEWAY'];
    const XY_TOL = 2.0;
    const good = [], singles = [], seen = new Set();

    const ids = this.ifcApi.GetLineIDsWithType(this.modelID, WebIFC.IFCTRANSPORTELEMENT);
    for (let i = 0; i < ids.size(); i++) {
      const eid = ids.get(i);
      if (seen.has(eid)) continue;
      seen.add(eid);
      const el = this.ifcApi.GetLine(this.modelID, eid);
      const pt = this._sv(el.PredefinedType).toUpperCase();
      if (SKIP.includes(pt)) continue;

      let sem = ['ELEVATOR','LIFT','USERDEFINED','NOTDEFINED'].includes(pt);
      if (!sem) {
        const txt = [el.Name, el.ObjectType, el.Description].map(v => this._sv(v).toUpperCase()).join(' ');
        sem = KW.some(k => txt.includes(k));
      }

      const { centroid, bbox } = this.getElementCentroidAndBbox(eid);
      if (!bbox) continue;
      // Z-up: horizontal extents are X (0→3) and Y (1→4); Z (2→5) is vertical (height)
      const dx = bbox[3]-bbox[0], dy = bbox[4]-bbox[1], dz = bbox[5]-bbox[2];
      const touched = this._sortedStoreys
        .filter(st => bbox[2]-0.5 <= st.elev && st.elev <= bbox[5]+0.5)
        .map(st => st.name);
      const [mnXY, mxXY, mnDZ] = sem ? [0.6, 8, 1] : [0.8, 6, 2.2];
      if (!(mnXY<=dx && dx<=mxXY && mnXY<=dy && dy<=mxXY) || dz<mnDZ || !touched.length) continue;

      if (touched.length >= 2) {
        const dh = touched.filter(lvl =>
          (this._doorsByLevel[lvl]||[]).some(d => this._d2d([centroid[0],centroid[1]],[d.x,d.y]) <= 5)
        ).length;
        if (sem || dh >= 1) good.push({ eid, centroid, bbox, levels: touched });
      } else if (sem) {
        singles.push({ eid, cx: centroid[0], cy: centroid[1], centroid, bbox, lvl: touched[0] });
      }
    }

    // Group single-floor cabins by XY proximity
    const groups = [];
    for (const c of singles) {
      let placed = false;
      for (const g of groups)
        if (Math.hypot(c.cx-g[0].cx, c.cy-g[0].cy) <= XY_TOL) { g.push(c); placed=true; break; }
      if (!placed) groups.push([c]);
    }
    for (const grp of groups) {
      const lvlSet = new Set(), lvls = [];
      for (const c of grp) if (c.lvl && !lvlSet.has(c.lvl)) { lvlSet.add(c.lvl); lvls.push(c.lvl); }
      lvls.sort((a,b) => (this.storeyElevByName[a]||0) - (this.storeyElevByName[b]||0));
      if (lvls.length < 2) continue;
      const cx = grp.reduce((s,c)=>s+c.cx,0)/grp.length;
      const cy = grp.reduce((s,c)=>s+c.cy,0)/grp.length;
      good.push({ eid: grp[0].eid, centroid:[cx,cy,grp[0].centroid[2]], bbox:grp[0].bbox, levels:lvls });
    }
    return good;
  }

  // ═══════════════════════════════════════════════════════
  // MAIN EXTRACTION
  // ═══════════════════════════════════════════════════════
  async extraerDatos(prog = () => {}) {

    // 1) SPACES
    prog('Espacios…', 5);
    const spaceIds = this.ifcApi.GetLineIDsWithType(this.modelID, WebIFC.IFCSPACE);
    for (let i = 0; i < spaceIds.size(); i++) {
      const eid = spaceIds.get(i);
      const sp  = this.ifcApi.GetLine(this.modelID, eid);
      const { centroid, bbox } = this.getElementCentroidAndBbox(eid);
      if (!centroid) continue;
      // Z-up model: use IFC Z for elevation snap, IFC Y for plan Y
      const lvl = this._containerOf.get(eid) || this.snapZToLevel(bbox[2]).name;
      const fz  = this.storeyElevByName[lvl] ?? this.snapZToLevel(bbox[2]).elev;
      const id = String(eid);
      this._addNode(id, { name: this._sv(sp.Name)||'Estancia', type:'Habitacion', level:lvl, x:centroid[0], y:centroid[1], z:fz, accessible:true });
      const info = { id, bbox, bbox2d:[bbox[0],bbox[1],bbox[3],bbox[4]], level:lvl };
      this._spacesData.push(info);
      this._bbox2dBySpace.set(id, info.bbox2d);
    }

    // 2) SMALL SLABS
    prog('Suelos…', 15);
    const slabIds = this.ifcApi.GetLineIDsWithType(this.modelID, WebIFC.IFCSLAB);
    for (let i = 0; i < slabIds.size(); i++) {
      const eid  = slabIds.get(i);
      const slab = this.ifcApi.GetLine(this.modelID, eid);
      if (['ROOF','BASESLAB'].includes(this._sv(slab.PredefinedType).toUpperCase())) continue;
      const { centroid, bbox } = this.getElementCentroidAndBbox(eid);
      if (!centroid) continue;
      // Z-up: horizontal extents are X (0→3) and Y (1→4); Z (2→5) is height
      if (bbox[3]-bbox[0]>10 && bbox[4]-bbox[1]>10) continue;
      if (this._spacesData.some(s => this._bbox2dContains([centroid[0],centroid[1]], s.bbox2d, 0.1))) continue;
      const lvl = this._containerOf.get(eid) || this.snapZToLevel(bbox[2]).name;
      const fz  = this.storeyElevByName[lvl] ?? this.snapZToLevel(bbox[2]).elev;
      const id = String(eid);
      this._addNode(id, { name:this._sv(slab.Name)||'Suelo/Pasillo', type:'Suelo', level:lvl, x:centroid[0], y:centroid[1], z:fz, accessible:true });
      const info = { id, bbox, bbox2d:[bbox[0],bbox[1],bbox[3],bbox[4]], level:lvl };
      this._spacesData.push(info);
      this._bbox2dBySpace.set(id, info.bbox2d);
    }

    // 3) DOORS
    prog('Puertas…', 30);
    const doorIds = this.ifcApi.GetLineIDsWithType(this.modelID, WebIFC.IFCDOOR);
    for (let i = 0; i < doorIds.size(); i++) {
      const eid  = doorIds.get(i);
      const door = this.ifcApi.GetLine(this.modelID, eid);
      const { centroid, bbox } = this.getElementCentroidAndBbox(eid);
      if (!centroid) continue;
      // Z-up: use IFC Z for elevation, IFC Y for plan Y
      const lvl = this._containerOf.get(eid) || this.snapZToLevel(bbox[2]).name;
      const fz  = this.storeyElevByName[lvl] ?? this.snapZToLevel(bbox[2]).elev;
      const width = this._fv(door.OverallWidth);
      const acc   = width > 0 ? width >= 0.85 : true;
      const { axis, normal } = this._doorFrame(eid);
      const id = String(eid);
      this._addNode(id, { name:this._sv(door.Name)||'Puerta', type:'Puerta', level:lvl, x:centroid[0], y:centroid[1], z:fz, width, accessible:acc, wallAxis:axis, wallNormal:normal });
      if (!this._doorsByLevel[lvl]) this._doorsByLevel[lvl] = [];
      this._doorsByLevel[lvl].push({ id, x:centroid[0], y:centroid[1], z:fz });

      const near = [];
      for (const s of this._spacesData) {
        if (s.level !== lvl) continue;
        if (this._bbox2dContains([centroid[0],centroid[1]], s.bbox2d, 0.65)) near.push([0, s]);
        else { const d = this._bbox2dDist([centroid[0],centroid[1]], s.bbox2d); if (d<=1.1) near.push([d, s]); }
      }
      near.sort((a,b)=>a[0]-b[0]);
      for (const [,s] of near.slice(0,2)) this._linkDoorSpace(id, s, acc?1:999999, acc);
    }

    // 4) STAIRS
    prog('Escaleras…', 50);
    const flightInfo = {}, processed = new Set();

    // ── Pre-paso: asignar niveles a cada tramo usando IfcRelAggregates ──────
    // Cuando la geometría llega en coordenadas locales (Z siempre 0→h sin
    // offset de planta), no podemos usar snapZToLevel(minZ) directamente.
    // Agrupamos los tramos por su IfcStair padre, determinamos el nivel de
    // inicio del eje de escaleras y asignamos niveles consecutivos a cada
    // tramo (ordenados por su Z de geometría relativa).
    // IMPORTANTE: usar GetLine(false) para obtener expressIDs numéricos.
    const flightLvlMap = {};   // eid → { lvlS, lvlE }
    try {
      const aggIds = this.ifcApi.GetLineIDsWithType(this.modelID, WebIFC.IFCRELAGGREGATES);
      for (let ai = 0; ai < aggIds.size(); ai++) {
        const rel = this.ifcApi.GetLine(this.modelID, aggIds.get(ai), false);
        const stairId = rel.RelatingObject?.value ?? rel.RelatingObject;
        if (typeof stairId !== 'number') continue;
        let isStair = false;
        try { isStair = this.ifcApi.GetLineType(this.modelID, stairId) === WebIFC.IFCSTAIR; } catch(_) {}
        if (!isStair) continue;

        const items = rel.RelatedObjects;
        const flightEids = [];
        for (const item of (Array.isArray(items) ? items : [items])) {
          const oid = item?.value ?? item;
          if (typeof oid === 'number') flightEids.push(oid);
        }
        if (!flightEids.length) continue;

        // Nivel de inicio del eje de escaleras: buscar en _containerOf al IfcStair
        // primero, luego a cualquiera de sus tramos
        let startLevel = this._containerOf.get(stairId);
        if (!startLevel) {
          for (const eid of flightEids) {
            startLevel = this._containerOf.get(eid);
            if (startLevel) break;
          }
        }
        if (!startLevel) startLevel = this._sortedStoreys[0]?.name;

        const baseIdx = Math.max(0, this._sortedStoreys.findIndex(s => s.name === startLevel));

        // Ordenar tramos por su minZ de geometría (relativo al tramo): aporta orden correcto
        const withZ = flightEids.map(eid => {
          const vv = this.getElementVertices(eid);
          return { eid, minZ: vv.length ? Math.min(...vv.map(p => p[2])) : 0 };
        });
        withZ.sort((a, b) => a.minZ - b.minZ);

        withZ.forEach(({ eid }, idx) => {
          const sIdx = Math.min(baseIdx + idx,     this._sortedStoreys.length - 1);
          const eIdx = Math.min(baseIdx + idx + 1, this._sortedStoreys.length - 1);
          flightLvlMap[eid] = {
            lvlS: this._sortedStoreys[sIdx].name,
            lvlE: this._sortedStoreys[eIdx].name,
          };
        });
      }
    } catch (_) {}

    // ── Bucle principal de tramos ────────────────────────────────────────────
    const stIds = this.ifcApi.GetLineIDsWithType(this.modelID, WebIFC.IFCSTAIRFLIGHT);
    for (let i = 0; i < stIds.size(); i++) {
      const eid = stIds.get(i);
      if (processed.has(eid)) continue;
      const v = this.getElementVertices(eid);
      if (!v.length) continue;

      const zs       = v.map(p => p[2]);
      const minZ     = Math.min(...zs), maxZ = Math.max(...zs);
      const geomHeight = maxZ - minZ;

      // Centroide XY de todo el tramo (no dividido por altura)
      const cx = v.reduce((s, p) => s + p[0], 0) / v.length;
      const cy = v.reduce((s, p) => s + p[1], 0) / v.length;

      // Asignación de niveles: mapa pre-calculado → _containerOf → snapZToLevel
      let lvlS, lvlE;
      if (flightLvlMap[eid]) {
        ({ lvlS, lvlE } = flightLvlMap[eid]);
      } else {
        lvlS = this._containerOf.get(eid) || this.snapZToLevel(minZ).name;
        const sIdx = this._sortedStoreys.findIndex(s => s.name === lvlS);
        if (geomHeight >= 0.5) {
          const byZ = this.snapZToLevel(maxZ).name;
          lvlE = (byZ !== lvlS) ? byZ
            : (sIdx + 1 < this._sortedStoreys.length ? this._sortedStoreys[sIdx + 1].name : lvlS);
        } else {
          lvlE = sIdx + 1 < this._sortedStoreys.length
            ? this._sortedStoreys[sIdx + 1].name : lvlS;
        }
      }

      // Posición Z: siempre desde storeyElevByName → conexiones limpias en 3D
      const fzS = this.storeyElevByName[lvlS] ?? minZ;
      const fzE = this.storeyElevByName[lvlE] ?? (fzS + 3.5);

      const idS = `${eid}_START`, idE = `${eid}_END`;
      this._addNode(idS, { name:'Escalera Inicio', type:'Escalera', level:lvlS, x:cx, y:cy, z:fzS, accessible:false });
      this._addNode(idE, { name:'Escalera Fin',   type:'Escalera', level:lvlE, x:cx, y:cy, z:fzE, accessible:false });
      this._addEdgePolyline(idS, idE, [[cx,cy,fzS],[cx,cy,fzE]], 999999, false, 'escalera');
      flightInfo[eid] = { startId:idS, endId:idE, startZ:fzS };

      for (const [nid, px, py, lvl] of [[idS,cx,cy,lvlS],[idE,cx,cy,lvlE]]) {
        let linked = false;
        for (const s of this._spacesData) {
          if (s.level === lvl && this._bbox2dContains([px, py], s.bbox2d, 0.5)) {
            this._linkVertSpace(nid, s); linked = true; break;
          }
        }
        if (!linked) {
          const doors = this._doorsByLevel[lvl] || [];
          if (doors.length) {
            const near = doors.reduce((b, d) =>
              this._d2d([px,py],[d.x,d.y]) < this._d2d([px,py],[b.x,b.y]) ? d : b);
            if (this._d2d([px,py],[near.x,near.y]) <= 5) this._linkVertDoor(nid, near.id);
          }
        }
      }
      processed.add(eid);
    }

    // ── Conectar tramos consecutivos (fix: GetLine(false)) ───────────────────
    const byStair = {};
    try {
      const aggIds = this.ifcApi.GetLineIDsWithType(this.modelID, WebIFC.IFCRELAGGREGATES);
      for (let i = 0; i < aggIds.size(); i++) {
        const rel = this.ifcApi.GetLine(this.modelID, aggIds.get(i), false);  // ← false!
        const rid = rel.RelatingObject?.value ?? rel.RelatingObject;
        if (typeof rid !== 'number') continue;
        let isStair = false;
        try { isStair = this.ifcApi.GetLineType(this.modelID, rid) === WebIFC.IFCSTAIR; } catch(_) {}
        if (!isStair) continue;
        for (const obj of (Array.isArray(rel.RelatedObjects)?rel.RelatedObjects:[rel.RelatedObjects])) {
          const oid = obj?.value ?? obj;
          if (typeof oid === 'number' && flightInfo[oid]) {
            if (!byStair[rid]) byStair[rid] = [];
            byStair[rid].push(oid);
          }
        }
      }
    } catch (_) {}
    for (const flights of Object.values(byStair)) {
      flights.sort((a, b) => flightInfo[a].startZ - flightInfo[b].startZ);
      for (let i = 0; i < flights.length - 1; i++) {
        const fi = flightInfo[flights[i]], fj = flightInfo[flights[i+1]];
        if (!this._hasEdge(fi.endId, fj.startId)) {
          const na = this.G.nodes.get(fi.endId), nb = this.G.nodes.get(fj.startId);
          this._addEdgePolyline(fi.endId, fj.startId,
            [[na.x,na.y,na.z],[nb.x,nb.y,nb.z]],
            Math.max(Math.hypot(na.x-nb.x,na.y-nb.y)*1.2, 0.5), false, 'escalera_rellano');
        }
      }
    }
    // Fallback geométrico (para tramos no agrupados en IfcStair)
    const sn = [...this.G.nodes.entries()].filter(([,d]) => d.type === 'Escalera');
    for (let i = 0; i < sn.length; i++) for (let j = i+1; j < sn.length; j++) {
      const [aId,a] = sn[i], [bId,b] = sn[j];
      if (this._hasEdge(aId,bId) || a.level === b.level) continue;
      const dxy = Math.hypot(a.x-b.x, a.y-b.y), dz = Math.abs(a.z-b.z);
      if (dxy <= 3.0 && 0.3 <= dz && dz <= 8)
        this._addEdgePolyline(aId,bId,[[a.x,a.y,a.z],[b.x,b.y,b.z]],Math.max(dxy*1.2,0.5),false,'escalera_rellano');
    }

    // 5) RAMPS
    prog('Rampas…', 65);
    for (const rtype of [WebIFC.IFCRAMP, WebIFC.IFCRAMPFLIGHT]) {
      const rids = this.ifcApi.GetLineIDsWithType(this.modelID, rtype);
      const done = new Set();
      for (let i=0;i<rids.size();i++) {
        const eid=rids.get(i); if(done.has(eid)) continue;
        const v=this.getElementVertices(eid); if(!v.length) continue;
        const zs=v.map(p=>p[2]); const mnZ=Math.min(...zs),mxZ=Math.max(...zs);
        if(mxZ-mnZ<0.15) continue;
        const iS=zs.indexOf(mnZ),iE=zs.indexOf(mxZ);
        const contained = this._containerOf.get(eid);
        const lvS = contained || this.snapZToLevel(mnZ).name;
        const sIdx = this._sortedStoreys.findIndex(s => s.name === lvS);
        const lvE = contained && sIdx >= 0 && sIdx+1 < this._sortedStoreys.length
          ? this._sortedStoreys[sIdx+1].name : this.snapZToLevel(mxZ).name;
        // Usar Z real de la geometría para mostrar pendiente correcta en 3D
        const fzS=mnZ, fzE=mxZ;
        const idS=`${eid}_START`,idE=`${eid}_END`;
        this._addNode(idS,{name:'Rampa Inicio',type:'Rampa',level:lvS,x:v[iS][0],y:v[iS][1],z:fzS,accessible:true});
        this._addNode(idE,{name:'Rampa Fin',  type:'Rampa',level:lvE,x:v[iE][0],y:v[iE][1],z:fzE,accessible:true});
        this._addEdgePolyline(idS,idE,[[v[iS][0],v[iS][1],fzS],[v[iE][0],v[iE][1],fzE]],1.2,true,'rampa');
        for (const [nid,px,py,lvl] of [[idS,v[iS][0],v[iS][1],lvS],[idE,v[iE][0],v[iE][1],lvE]]) {
          let lk=false;
          for (const s of this._spacesData) if(s.level===lvl&&this._bbox2dContains([px,py],s.bbox2d,0.4)){this._linkVertSpace(nid,s);lk=true;break;}
          if (!lk){const ds=this._doorsByLevel[lvl]||[];if(ds.length){const nr=ds.reduce((b,d)=>this._d2d([px,py],[d.x,d.y])<this._d2d([px,py],[b.x,b.y])?d:b);if(this._d2d([px,py],[nr.x,nr.y])<=3)this._linkVertDoor(nid,nr.id);}}
        }
        done.add(eid);
      }
    }

    // 6) LIFTS
    prog('Ascensores…', 80);
    for (const { eid, centroid, levels } of this._findLifts()) {
      let prevId = null;
      for (const lvl of levels) {
        const lvlZ = this.storeyElevByName[lvl];
        const nid  = `${eid}_${lvl}`;
        this._addNode(nid, { name:'Ascensor', type:'Ascensor', level:lvl, x:centroid[0], y:centroid[1], z:lvlZ, accessible:true });
        if (prevId) {
          const pn = this.G.nodes.get(prevId);
          this._addEdgePolyline(prevId, nid, [[pn.x,pn.y,pn.z],[centroid[0],centroid[1],lvlZ]], 1, true, 'ascensor');
        }
        prevId = nid;
        const near = (this._doorsByLevel[lvl]||[])
          .map(d => ({...d, dist:this._d2d([centroid[0],centroid[1]],[d.x,d.y])}))
          .filter(d => d.dist<=5).sort((a,b)=>a.dist-b.dist).slice(0,2);
        let lk = false;
        for (const d of near) { this._linkVertDoor(nid, d.id); lk=true; }
        if (!lk) {
          const cands = this._spacesData.filter(s=>s.level===lvl)
            .map(s=>({...s,d:this._bbox2dDist([centroid[0],centroid[1]],s.bbox2d)})).sort((a,b)=>a.d-b.d);
          for (const s of cands.slice(0,2)) if(s.d<=2.5){this._linkVertSpace(nid,s);lk=true;break;}
        }
      }
    }

    // 7) FLOOR PLANS
    prog('Planos de planta…', 90);
    this._collectFloorplans();
    prog('Completado', 100);
  }

  // ═══════════════════════════════════════════════════════
  // DIJKSTRA
  // ═══════════════════════════════════════════════════════
  calcularRuta(startId, endId, wheelchair = false) {
    const dist = new Map(), prev = new Map(), vis = new Set();
    for (const id of this.G.nodes.keys()) dist.set(id, Infinity);
    dist.set(startId, 0);
    // Min-heap using sorted array (adequate for typical graph sizes)
    const pq = [[0, startId]];
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, u] = pq.shift();
      if (vis.has(u)) continue;
      vis.add(u);
      if (u === endId) break;
      for (const [v, e] of (this.G.adj.get(u)||new Map())) {
        if (wheelchair && !e.accessible) continue;
        const nd = d + (e.weight||1);
        if (nd < dist.get(v)) { dist.set(v, nd); prev.set(v, u); pq.push([nd, v]); }
      }
    }
    if (!isFinite(dist.get(endId))) return { found:false, path:[], weight:null };
    const path = []; let cur = endId;
    while (cur !== undefined) { path.unshift(cur); cur = prev.get(cur); }
    return { found:true, path, weight: dist.get(endId) };
  }

  // ═══════════════════════════════════════════════════════
  // EXPORT  (same shape as Python /api/upload response)
  // ═══════════════════════════════════════════════════════
  exportGraphData() {
    const nodes = [];
    for (const [id, d] of this.G.nodes)
      nodes.push({ id, name:d.name||'', type:d.type||'', level:d.level||'',
        x:+d.x.toFixed(4), y:+d.y.toFixed(4), z:+d.z.toFixed(4),
        accessible: d.accessible!==false,
        width: d.width!=null ? +d.width.toFixed(3) : null });

    const edges = [];
    for (const [, e] of this.G.edges)
      edges.push({ u:e.u, v:e.v, type:e.edgeType||'camino',
        accessible:e.accessible!==false, levels:e.levels||'',
        weight:+(e.weight||1).toFixed(2), coords:e.coords });

    return {
      nodes, edges,
      storeys:    this._sortedStoreys.map(s => s.name),
      floorplans: this._storeyPolylines,
    };
  }
}
