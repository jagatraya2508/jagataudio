import os
from basic_pitch.inference import predict
import mido

def generate_tab_from_audio(audio_path, output_txt_path):
    print(f"Generating tab for {audio_path}...")
    try:
        # Run basic-pitch inference
        model_output, midi_data, note_events = predict(audio_path)
        
        # Save as MIDI
        midi_path = output_txt_path.replace('.txt', '.mid')
        midi_data.write(midi_path)
        
        # Simple naive converter from MIDI to text tab
        # Standard tuning: E4(64), B3(59), G3(55), D3(50), A2(45), E2(40)
        strings = [64, 59, 55, 50, 45, 40]
        string_names = ['E', 'B', 'G', 'D', 'A', 'E']
        
        notes = []
        for event in note_events:
            start_time = event[0]
            pitch = event[2]
            notes.append((start_time, pitch))
        
        notes.sort(key=lambda x: x[0])
        
        if len(notes) == 0:
            with open(output_txt_path, 'w') as f:
                f.write("=== JAGAT AUDIO - AUTO GENERATED TAB ===\n")
                f.write("Peringatan: Ini adalah hasil transkripsi AI (Eksperimental).\n\n")
                f.write("Tidak ada nada yang terdeteksi.\n")
            return output_txt_path
        
        # Group notes by time buckets (e.g. 100ms)
        step_size = 0.10
        buckets = {}
        for time, pitch in notes:
            bucket_idx = int(time / step_size)
            if bucket_idx not in buckets:
                buckets[bucket_idx] = []
            buckets[bucket_idx].append(pitch)
            
        max_bucket = max(buckets.keys())
        tab_lines = {i: [] for i in range(6)}
        
        for b in range(max_bucket + 1):
            if b not in buckets:
                for i in range(6):
                    tab_lines[i].append('-')
                continue
                
            bucket_notes = buckets[b]
            string_frets = {i: '-' for i in range(6)}
            
            # Sort notes highest to lowest to map to thinnest strings first
            bucket_notes.sort(reverse=True)
            
            for pitch in bucket_notes:
                best_string = -1
                best_fret = 999
                for i, s_pitch in enumerate(strings):
                    if string_frets[i] == '-': # String not used in this chord yet
                        fret = pitch - s_pitch
                        if 0 <= fret < best_fret and fret <= 24:
                            best_fret = fret
                            best_string = i
                            
                if best_string != -1:
                    string_frets[best_string] = str(best_fret)
                    
            # Find max width of frets in this chord to align
            max_len = max([len(f) for f in string_frets.values()])
            
            for i in range(6):
                f_str = string_frets[i]
                if f_str == '-':
                    tab_lines[i].append('-' * max_len)
                else:
                    tab_lines[i].append(f_str.ljust(max_len, '-'))
                    
        with open(output_txt_path, 'w') as f:
            f.write("=== JAGAT AUDIO - AUTO GENERATED TAB ===\n")
            f.write("Peringatan: Ini adalah hasil transkripsi AI (Eksperimental).\n\n")
                
            chunk_size = 60
            total_len = len(tab_lines[0])
            for chunk_start in range(0, total_len, chunk_size):
                for i in range(6):
                    line_str = "-".join(tab_lines[i][chunk_start:chunk_start+chunk_size])
                    f.write(f"{string_names[i]} |-{line_str}-|\n")
                f.write("\n")
                
        return output_txt_path
    except Exception as e:
        print("Error in basic-pitch:", str(e))
        with open(output_txt_path, 'w') as f:
            f.write(f"Terjadi kesalahan saat membuat tabulatur:\n{str(e)}")
        return output_txt_path

if __name__ == '__main__':
    # Test
    pass
