// Thin C ABI over LibRaw for the browser.
//
// The wrapper deliberately stops after unpack(): black level, white level,
// demosaicing, white balance and the camera matrix are all applied later in
// WGSL (src/raw/). LibRaw is used for what it is best at — parsing every
// flavour of DNG/TIFF container and decompressing the sensor data — and
// hands back the untouched integer samples plus every piece of colour
// metadata needed to develop them correctly.

#include <emscripten/emscripten.h>
#include <cstdio>
#include <cstring>
#include <string>
#include "libraw/libraw.h"

static LibRaw *g_proc = nullptr;
static std::string g_json;

namespace {

struct Json {
  std::string s;
  bool first = true;
  void key(const char *k) {
    if (!first) s += ',';
    first = false;
    s += '"';
    s += k;
    s += "\":";
  }
  void num(const char *k, double v) {
    key(k);
    char buf[64];
    if (v != v) v = 0; // NaN is not JSON
    snprintf(buf, sizeof buf, "%.9g", v);
    s += buf;
  }
  void str(const char *k, const char *v) {
    key(k);
    s += '"';
    for (const char *p = v; p && *p; ++p) {
      unsigned char c = (unsigned char)*p;
      if (c == '"' || c == '\\') { s += '\\'; s += (char)c; }
      else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); s += b; }
      else s += (char)c;
    }
    s += '"';
  }
  template <typename T> void arr(const char *k, const T *v, int n) {
    key(k);
    s += '[';
    for (int i = 0; i < n; i++) {
      char buf[64];
      double d = (double)v[i];
      if (d != d) d = 0;
      snprintf(buf, sizeof buf, "%s%.9g", i ? "," : "", d);
      s += buf;
    }
    s += ']';
  }
  void open(const char *k) { key(k); s += '{'; first = true; }
  void close() { s += '}'; first = false; }
};

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int lr_open(const void *data, size_t size) {
  if (g_proc) { g_proc->recycle(); delete g_proc; }
  g_proc = new LibRaw(0);
  // Keep full precision and do not let LibRaw touch the data after unpack.
  g_proc->imgdata.rawparams.max_raw_memory_mb = 3072;
  return g_proc->open_buffer(data, size);
}

EMSCRIPTEN_KEEPALIVE int lr_unpack() { return g_proc ? g_proc->unpack() : -1; }

EMSCRIPTEN_KEEPALIVE const char *lr_strerror(int code) { return libraw_strerror(code); }

// 1 = CFA (raw_image, one ushort per photosite)
// 3 = three samples per pixel (color3_image) — LinearRaw such as ProRAW
// 4 = four samples per pixel (color4_image)
// 0 = unsupported layout (e.g. floating-point DNG after conversion failed)
EMSCRIPTEN_KEEPALIVE int lr_raw_kind() {
  if (!g_proc) return 0;
  auto &r = g_proc->imgdata.rawdata;
  if (r.raw_image) return 1;
  if (r.color3_image) return 3;
  if (r.color4_image) return 4;
  return 0;
}

EMSCRIPTEN_KEEPALIVE const void *lr_raw_ptr() {
  if (!g_proc) return nullptr;
  auto &r = g_proc->imgdata.rawdata;
  if (r.raw_image) return r.raw_image;
  if (r.color3_image) return r.color3_image;
  if (r.color4_image) return r.color4_image;
  return nullptr;
}

EMSCRIPTEN_KEEPALIVE const char *lr_meta_json() {
  if (!g_proc) return "{}";
  auto &d = g_proc->imgdata;
  Json j;
  j.s = "{";
  j.num("rawKind", lr_raw_kind());
  j.open("sizes");
  j.num("rawWidth", d.sizes.raw_width);
  j.num("rawHeight", d.sizes.raw_height);
  j.num("width", d.sizes.width);
  j.num("height", d.sizes.height);
  j.num("topMargin", d.sizes.top_margin);
  j.num("leftMargin", d.sizes.left_margin);
  j.num("rawPitch", d.sizes.raw_pitch);
  j.num("flip", d.sizes.flip);
  j.num("pixelAspect", d.sizes.pixel_aspect);
  {
    ushort c[4] = {d.sizes.raw_inset_crops[0].cleft, d.sizes.raw_inset_crops[0].ctop,
                   d.sizes.raw_inset_crops[0].cwidth, d.sizes.raw_inset_crops[0].cheight};
    j.arr("insetCrop", c, 4);
  }
  j.close();

  j.open("idata");
  j.str("make", d.idata.make);
  j.str("model", d.idata.model);
  j.str("normalizedMake", d.idata.normalized_make);
  j.str("normalizedModel", d.idata.normalized_model);
  j.str("software", d.idata.software);
  j.num("dngVersion", d.idata.dng_version);
  j.num("colors", d.idata.colors);
  j.num("filters", d.idata.filters);
  j.str("cdesc", d.idata.cdesc);
  {
    // Expand the CFA to a 16x16 table of colour indices (FC(row,col)).
    int fc[256];
    for (int r = 0; r < 16; r++)
      for (int c = 0; c < 16; c++) fc[r * 16 + c] = g_proc->COLOR(r, c);
    j.arr("cfa16", fc, 256);
  }
  j.close();

  j.open("color");
  j.num("black", d.color.black);
  j.arr("cblack", d.color.cblack, 4 + 2 + 36);
  j.num("maximum", d.color.maximum);
  j.arr("linearMax", d.color.linear_max, 4);
  j.arr("camMul", d.color.cam_mul, 4);
  j.arr("preMul", d.color.pre_mul, 4);
  j.arr("rgbCam", &d.color.rgb_cam[0][0], 12);
  j.arr("camXyz", &d.color.cam_xyz[0][0], 12);
  j.num("flashUsed", d.color.flash_used);
  for (int k = 0; k < 2; k++) {
    j.open(k ? "dng2" : "dng1");
    j.num("illuminant", d.color.dng_color[k].illuminant);
    j.arr("calibration", &d.color.dng_color[k].calibration[0][0], 16);
    j.arr("colorMatrix", &d.color.dng_color[k].colormatrix[0][0], 12);
    j.arr("forwardMatrix", &d.color.dng_color[k].forwardmatrix[0][0], 12);
    j.close();
  }
  j.open("dngLevels");
  j.num("black", d.color.dng_levels.dng_black);
  j.arr("cblack", d.color.dng_levels.dng_cblack, 4 + 2 + 36);
  j.arr("whiteLevel", d.color.dng_levels.dng_whitelevel, 4);
  j.arr("defaultCrop", d.color.dng_levels.default_crop, 4);
  j.arr("analogBalance", d.color.dng_levels.analogbalance, 4);
  j.arr("asShotNeutral", d.color.dng_levels.asshotneutral, 4);
  j.num("baselineExposure", d.color.dng_levels.baseline_exposure);
  j.num("linearResponseLimit", d.color.dng_levels.LinearResponseLimit);
  j.close();
  j.close();

  j.open("other");
  j.num("iso", d.other.iso_speed);
  j.num("shutter", d.other.shutter);
  j.num("aperture", d.other.aperture);
  j.num("focalLength", d.other.focal_len);
  j.num("timestamp", (double)d.other.timestamp);
  j.str("artist", d.other.artist);
  j.str("description", d.other.desc);
  j.num("gpsParsed", d.other.parsed_gps.gpsparsed);
  j.arr("latitude", d.other.parsed_gps.latitude, 3);
  j.arr("longitude", d.other.parsed_gps.longitude, 3);
  j.num("altitude", d.other.parsed_gps.altitude);
  {
    char r[2] = {d.other.parsed_gps.latref, 0};
    char o[2] = {d.other.parsed_gps.longref, 0};
    j.str("latRef", r);
    j.str("lonRef", o);
  }
  j.close();

  j.open("lens");
  j.str("make", d.lens.LensMake);
  j.str("model", d.lens.Lens);
  j.num("focalLength35", d.lens.FocalLengthIn35mmFormat);
  j.close();

  j.s += '}';
  g_json = j.s;
  return g_json.c_str();
}

EMSCRIPTEN_KEEPALIVE void lr_close() {
  if (g_proc) { g_proc->recycle(); delete g_proc; g_proc = nullptr; }
  g_json.clear();
  g_json.shrink_to_fit();
}

EMSCRIPTEN_KEEPALIVE void *lr_malloc(size_t n) { return malloc(n); }
EMSCRIPTEN_KEEPALIVE void lr_free(void *p) { free(p); }

} // extern "C"
