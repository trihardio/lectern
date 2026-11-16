#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <Speech/Speech.h>
#include <signal.h>

// A separate bundle gives permissions a stable identity, even in development.
// Audio stays in memory; only temporary transcript/status JSON reaches Lectern.
@interface LecternVoice : NSObject <NSApplicationDelegate>
@property NSURL *directory;
@property NSString *locale;
@property pid_t ownerPID;
@property AVAudioEngine *engine;
@property SFSpeechAudioBufferRecognitionRequest *request;
@property SFSpeechRecognitionTask *task;
@property SFSpeechRecognizer *recognizer;
@property NSTimer *timer;
@property NSString *text;
@property NSDate *began;
@property BOOL tapped;
@property BOOL finished;
@end

@implementation LecternVoice
- (NSURL *)file:(NSString *)name { return [self.directory URLByAppendingPathComponent:name]; }
- (void)publish:(NSString *)state error:(NSString *)error {
    NSDictionary *value = @{ @"state": state, @"text": self.text ?: @"", @"error": error ?: @"" };
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    [data writeToURL:[self file:@"status.json"] options:NSDataWritingAtomic error:nil];
}
- (void)finish:(NSString *)error {
    if (self.finished) return;
    self.finished = YES;
    [self.timer invalidate];
    [self.engine stop];
    if (self.tapped) [self.engine.inputNode removeTapOnBus:0];
    [self.request endAudio];
    [self.task cancel];
    [self publish:error.length ? @"error" : @"stopped" error:error];
    [NSApp terminate:nil];
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.began = [NSDate date];
    self.text = @"";
    if (self.ownerPID <= 0 || kill(self.ownerPID, 0) != 0 || [[NSFileManager defaultManager] fileExistsAtPath:[self file:@"stop"].path]) {
        [self finish:nil];
        return;
    }
    [self publish:@"starting" error:nil];
    self.timer = [NSTimer scheduledTimerWithTimeInterval:0.2 repeats:YES block:^(NSTimer *timer) {
        BOOL stopped = [[NSFileManager defaultManager] fileExistsAtPath:[self file:@"stop"].path];
        NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:[self file:@"heartbeat"].path error:nil];
        NSDate *heartbeat = attrs[NSFileModificationDate] ?: self.began;
        if (stopped || ![[NSFileManager defaultManager] fileExistsAtPath:self.directory.path] || self.ownerPID <= 0 || kill(self.ownerPID, 0) != 0 || -heartbeat.timeIntervalSinceNow > 15) {
            [self finish:nil];
        } else if (-self.began.timeIntervalSinceNow > 120) {
            [self finish:@"Voice input ended after two minutes. Click the mic to continue."];
        }
    }];
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.finished) return;
            if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                [self finish:@"Allow Lectern Voice in System Settings → Privacy & Security → Speech Recognition, then try again."];
                return;
            }
            [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL allowed) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (self.finished) return;
                    if (allowed) [self start];
                    else [self finish:@"Allow Lectern Voice in System Settings → Privacy & Security → Microphone, then try again."];
                });
            }];
        });
    }];
}
- (void)start {
    self.recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:self.locale]];
    if (!self.recognizer || !self.recognizer.available) {
        [self finish:@"Speech recognition is unavailable for this language. Check your internet connection and try again."];
        return;
    }
    self.request = [SFSpeechAudioBufferRecognitionRequest new];
    self.request.shouldReportPartialResults = YES;
    self.request.taskHint = SFSpeechRecognitionTaskHintDictation;
    self.request.requiresOnDeviceRecognition = self.recognizer.supportsOnDeviceRecognition;
    self.engine = [AVAudioEngine new];
    AVAudioInputNode *input = self.engine.inputNode;
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (format.sampleRate <= 0 || format.channelCount == 0) {
        [self finish:@"No microphone is available. Choose an input device in System Settings → Sound."];
        return;
    }
    self.task = [self.recognizer recognitionTaskWithRequest:self.request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.finished) return;
            if (result) {
                NSString *text = result.bestTranscription.formattedString;
                self.text = text.length > 50000 ? [text substringToIndex:50000] : text;
                [self publish:@"listening" error:nil];
                if (result.final) { [self finish:nil]; return; }
            }
            if (error) [self finish:[@"Speech recognition stopped: " stringByAppendingString:error.localizedDescription]];
        });
    }];
    SFSpeechAudioBufferRecognitionRequest *request = self.request;
    [input installTapOnBus:0 bufferSize:1024 format:format block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        [request appendAudioPCMBuffer:buffer];
    }];
    self.tapped = YES;
    NSError *error = nil;
    [self.engine prepare];
    if (![self.engine startAndReturnError:&error]) {
        [self finish:[@"The microphone could not start: " stringByAppendingString:error.localizedDescription ?: @"Unknown audio error."]];
        return;
    }
    [self publish:@"listening" error:nil];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 4) return 2;
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        LecternVoice *voice = [LecternVoice new];
        voice.directory = [NSURL fileURLWithPath:@(argv[1]) isDirectory:YES];
        voice.locale = @(argv[2]);
        voice.ownerPID = (pid_t)atoi(argv[3]);
        app.delegate = voice;
        [app run];
    }
    return 0;
}
