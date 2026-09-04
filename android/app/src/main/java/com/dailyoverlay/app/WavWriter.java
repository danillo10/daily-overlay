package com.dailyoverlay.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

public final class WavWriter {
    private WavWriter() {}

    public static byte[] pcm16ToWav(byte[] pcm, int sampleRate, int channels) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(44 + pcm.length);
        int byteRate = sampleRate * channels * 2;
        try {
            out.write(new byte[]{'R', 'I', 'F', 'F'});
            writeInt(out, 36 + pcm.length);
            out.write(new byte[]{'W', 'A', 'V', 'E', 'f', 'm', 't', ' '});
            writeInt(out, 16);
            writeShort(out, 1);
            writeShort(out, channels);
            writeInt(out, sampleRate);
            writeInt(out, byteRate);
            writeShort(out, channels * 2);
            writeShort(out, 16);
            out.write(new byte[]{'d', 'a', 't', 'a'});
            writeInt(out, pcm.length);
            out.write(pcm);
        } catch (IOException ignored) {
            return new byte[0];
        }
        return out.toByteArray();
    }

    private static void writeInt(ByteArrayOutputStream out, int value) {
        out.write(value);
        out.write(value >> 8);
        out.write(value >> 16);
        out.write(value >> 24);
    }

    private static void writeShort(ByteArrayOutputStream out, int value) {
        out.write(value);
        out.write(value >> 8);
    }
}
