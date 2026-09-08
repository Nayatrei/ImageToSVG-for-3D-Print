import * as THREE from './vendor/three/build/three.module.js?v=r-78ade4c03db6e3a2';
import { SVGLoader } from './vendor/three/examples/jsm/loaders/SVGLoader.js?v=r-78ade4c03db6e3a2';
import { OBJExporter } from './vendor/three/examples/jsm/exporters/OBJExporter.js?v=r-78ade4c03db6e3a2';
import * as BufferGeometryUtils from './vendor/three/examples/jsm/utils/BufferGeometryUtils.js?v=r-78ade4c03db6e3a2';

window.THREE = THREE;
window.SVGLoader = SVGLoader;
window.OBJExporter = OBJExporter;
window.BufferGeometryUtils = BufferGeometryUtils;
