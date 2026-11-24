/*
 * JNI bridge for build.hands.update.internal.BundledZlib: a raw-deflate
 * stream backed by the stock zlib 1.3.1 sources vendored under zlib/.
 *
 * Delta APK patches are generated on a server whose java.util.zip.Deflater
 * runs stock zlib. Since Android 12 the platform libz is Chromium's fork, whose
 * deflate output differs, so recompressing with the system Deflater rebuilds
 * an APK with the wrong bytes. This bridge mirrors OpenJDK 17's
 * java.util.zip.Deflater native code (Deflater.c) call for call, so that the
 * Kotlin wrapper behaves exactly like java.util.zip.Deflater on stock zlib.
 *
 * zlib is compiled with Z_PREFIX and hidden visibility, so none of its symbols
 * clash with or are interposed by the system libz.
 */
#include <jni.h>
#include <stdint.h>
#include <stdlib.h>

#include "zlib/zlib.h"

#define HANDS_DEF_MEM_LEVEL 8

static void throw_new(JNIEnv *env, const char *class_name, const char *message) {
    jclass cls = (*env)->FindClass(env, class_name);
    if (cls != NULL) {
        (*env)->ThrowNew(env, cls, message);
        (*env)->DeleteLocalRef(env, cls);
    }
}

static z_stream *stream_of(jlong addr) {
    return (z_stream *)(intptr_t)addr;
}

JNIEXPORT jlong JNICALL
Java_build_hands_update_internal_BundledZlib_nativeInit(JNIEnv *env, jclass clazz, jint level,
                                                        jint strategy, jboolean nowrap) {
    (void)clazz;
    z_stream *strm = calloc(1, sizeof(z_stream));
    if (strm == NULL) {
        throw_new(env, "java/lang/OutOfMemoryError", NULL);
        return 0;
    }
    switch (deflateInit2(strm, level, Z_DEFLATED, nowrap ? -MAX_WBITS : MAX_WBITS,
                         HANDS_DEF_MEM_LEVEL, strategy)) {
        case Z_OK:
            return (jlong)(intptr_t)strm;
        case Z_MEM_ERROR:
            free(strm);
            throw_new(env, "java/lang/OutOfMemoryError", NULL);
            return 0;
        case Z_STREAM_ERROR:
            free(strm);
            throw_new(env, "java/lang/IllegalArgumentException", NULL);
            return 0;
        default: {
            const char *msg = strm->msg;
            free(strm);
            throw_new(env, "java/lang/InternalError", msg);
            return 0;
        }
    }
}

JNIEXPORT void JNICALL
Java_build_hands_update_internal_BundledZlib_nativeSetDictionary(JNIEnv *env, jclass clazz,
                                                                 jlong addr, jbyteArray dictionary,
                                                                 jint off, jint len) {
    (void)clazz;
    z_stream *strm = stream_of(addr);
    jbyte *buf = (*env)->GetPrimitiveArrayCritical(env, dictionary, NULL);
    if (buf == NULL) return; /* OutOfMemoryError already pending */
    int res = deflateSetDictionary(strm, (const Bytef *)(buf + off), (uInt)len);
    (*env)->ReleasePrimitiveArrayCritical(env, dictionary, buf, JNI_ABORT);
    switch (res) {
        case Z_OK:
            break;
        case Z_STREAM_ERROR:
            throw_new(env, "java/lang/IllegalArgumentException", NULL);
            break;
        default:
            throw_new(env, "java/lang/InternalError", strm->msg);
            break;
    }
}

/*
 * One deflate (or deflateParams) step, packed exactly like OpenJDK's
 * Deflater.deflateBytesBytes: bits 0-30 input consumed, 31-61 output written,
 * bit 62 stream finished, bit 63 "params still pending" (deflateParams
 * returned Z_BUF_ERROR and must be retried).
 *
 * params: bit 0 set => call deflateParams instead of deflate; bits 1-2 the
 * strategy; bits 3-31 the level (arithmetic shift keeps -1).
 */
JNIEXPORT jlong JNICALL
Java_build_hands_update_internal_BundledZlib_nativeDeflate(JNIEnv *env, jclass clazz, jlong addr,
                                                           jbyteArray input, jint input_off,
                                                           jint input_len, jbyteArray output,
                                                           jint output_off, jint output_len,
                                                           jint flush, jint params) {
    (void)clazz;
    z_stream *strm = stream_of(addr);
    jbyte *in_buf = NULL;
    if (input != NULL) {
        in_buf = (*env)->GetPrimitiveArrayCritical(env, input, NULL);
        if (in_buf == NULL) return 0L;
    }
    jbyte *out_buf = (*env)->GetPrimitiveArrayCritical(env, output, NULL);
    if (out_buf == NULL) {
        if (in_buf != NULL) (*env)->ReleasePrimitiveArrayCritical(env, input, in_buf, JNI_ABORT);
        return 0L;
    }

    int set_params = params & 1;
    strm->next_in = in_buf != NULL ? (Bytef *)(in_buf + input_off) : Z_NULL;
    strm->avail_in = (uInt)input_len;
    strm->next_out = (Bytef *)(out_buf + output_off);
    strm->avail_out = (uInt)output_len;

    int res;
    if (set_params) {
        int strategy = (params >> 1) & 3;
        int level = params >> 3;
        res = deflateParams(strm, level, strategy);
    } else {
        res = deflate(strm, flush);
    }
    jint input_used = 0;
    jint output_used = 0;
    int finished = 0;
    int ok = 1;
    if (set_params) {
        switch (res) {
            case Z_OK:
                set_params = 0;
                /* fall through */
            case Z_BUF_ERROR:
                input_used = input_len - (jint)strm->avail_in;
                output_used = output_len - (jint)strm->avail_out;
                break;
            default:
                ok = 0;
                break;
        }
    } else {
        switch (res) {
            case Z_STREAM_END:
                finished = 1;
                /* fall through */
            case Z_OK:
                input_used = input_len - (jint)strm->avail_in;
                output_used = output_len - (jint)strm->avail_out;
                break;
            case Z_BUF_ERROR:
                break;
            default:
                ok = 0;
                break;
        }
    }
    /* Never leave pointers into Java arrays behind in the stream. */
    strm->next_in = Z_NULL;
    strm->avail_in = 0;
    strm->next_out = Z_NULL;
    strm->avail_out = 0;

    (*env)->ReleasePrimitiveArrayCritical(env, output, out_buf, 0);
    if (in_buf != NULL) (*env)->ReleasePrimitiveArrayCritical(env, input, in_buf, JNI_ABORT);

    if (!ok) {
        throw_new(env, "java/lang/InternalError", strm->msg);
        return 0L;
    }
    return ((jlong)input_used) | (((jlong)output_used) << 31) | (((jlong)finished) << 62) |
           (((jlong)set_params) << 63);
}

JNIEXPORT jint JNICALL
Java_build_hands_update_internal_BundledZlib_nativeGetAdler(JNIEnv *env, jclass clazz, jlong addr) {
    (void)env;
    (void)clazz;
    return (jint)stream_of(addr)->adler;
}

JNIEXPORT void JNICALL
Java_build_hands_update_internal_BundledZlib_nativeReset(JNIEnv *env, jclass clazz, jlong addr) {
    (void)clazz;
    z_stream *strm = stream_of(addr);
    if (deflateReset(strm) != Z_OK) {
        throw_new(env, "java/lang/InternalError", NULL);
    }
}

JNIEXPORT void JNICALL
Java_build_hands_update_internal_BundledZlib_nativeEnd(JNIEnv *env, jclass clazz, jlong addr) {
    (void)clazz;
    z_stream *strm = stream_of(addr);
    if (deflateEnd(strm) == Z_STREAM_ERROR) {
        throw_new(env, "java/lang/InternalError", NULL);
    } else {
        free(strm);
    }
}

JNIEXPORT jstring JNICALL
Java_build_hands_update_internal_BundledZlib_nativeZlibVersion(JNIEnv *env, jclass clazz) {
    (void)clazz;
    return (*env)->NewStringUTF(env, zlibVersion());
}
