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
        
        tab_lines = {i: [] for i in range(6)}
        current_time = 0.0
        step_size = 0.15 # roughly 16th notes
        
        for time, pitch in notes:
            # Add padding dashes if there's a gap
            while current_time < time - step_size:
                for i in range(6):
                    tab_lines[i].append('-')
                current_time += step_size
                
            # Find best string (lowest fret >= 0)
            best_string = -1
            best_fret = 999
            for i, s_pitch in enumerate(strings):
                fret = pitch - s_pitch
                if 0 <= fret < best_fret and fret <= 22:
                    best_fret = fret
                    best_string = i
                    
            if best_string != -1:
                # To align correctly, make all appends same length
                fret_str = str(best_fret)
                pad_len = len(fret_str)
                for i in range(6):
                    if i == best_string:
                        tab_lines[i].append(fret_str)
                    else:
                        tab_lines[i].append('-' * pad_len)
            current_time += step_size
            
        with open(output_txt_path, 'w') as f:
            f.write("=== JAGAT AUDIO - AUTO GENERATED TAB ===\n")
            f.write("Peringatan: Ini adalah hasil transkripsi AI (Eksperimental).\n\n")
            
            if len(notes) == 0:
                f.write("Tidak ada nada yang terdeteksi.\n")
                return output_txt_path
                
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
