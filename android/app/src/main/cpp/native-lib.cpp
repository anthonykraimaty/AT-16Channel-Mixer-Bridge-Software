// Starts the Node runtime inside the app and sends what it prints to the
// Android log.
#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>
#include "node.h"

static const char *TAG = "MixerBridge";
static int out_pipe[2];
static int err_pipe[2];
static pthread_t out_thread;
static pthread_t err_thread;

static void *forward(void *arg) {
    int *pipe_fd = static_cast<int *>(arg);
    int priority = pipe_fd == err_pipe ? ANDROID_LOG_WARN : ANDROID_LOG_INFO;
    char buffer[2048];
    ssize_t count;
    while ((count = read(pipe_fd[0], buffer, sizeof buffer - 1)) > 0) {
        if (buffer[count - 1] == '\n') count--;
        buffer[count] = 0;
        __android_log_write(priority, TAG, buffer);
    }
    return nullptr;
}

static void redirect_output() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    pipe(out_pipe);
    dup2(out_pipe[1], STDOUT_FILENO);
    pthread_create(&out_thread, nullptr, forward, out_pipe);
    pthread_detach(out_thread);

    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(err_pipe);
    dup2(err_pipe[1], STDERR_FILENO);
    pthread_create(&err_thread, nullptr, forward, err_pipe);
    pthread_detach(err_thread);
}

extern "C" JNIEXPORT jint JNICALL
Java_app_mixerbridge_NodeRunner_startNode(JNIEnv *env, jclass, jobjectArray arguments) {
    jsize count = env->GetArrayLength(arguments);

    // Node wants its arguments in one block of memory, one after the other.
    size_t size = 0;
    for (jsize i = 0; i < count; i++) {
        auto text = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char *chars = env->GetStringUTFChars(text, nullptr);
        size += strlen(chars) + 1;
        env->ReleaseStringUTFChars(text, chars);
    }
    char *block = static_cast<char *>(calloc(size, sizeof(char)));
    char **argv = static_cast<char **>(calloc(count, sizeof(char *)));
    char *position = block;
    for (jsize i = 0; i < count; i++) {
        auto text = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char *chars = env->GetStringUTFChars(text, nullptr);
        strcpy(position, chars);
        argv[i] = position;
        position += strlen(chars) + 1;
        env->ReleaseStringUTFChars(text, chars);
    }

    redirect_output();
    int result = node::Start(count, argv);
    free(argv);
    free(block);
    return jint(result);
}
